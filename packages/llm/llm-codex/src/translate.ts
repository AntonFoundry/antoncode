/**
 * Translate Codex Responses SSE events into harness StreamChunks. One
 * stateful harness block per open message/text, reasoning-summary, and
 * function-call output item; `response.completed` closes every open block,
 * reports usage, and emits the finish reason (tool-calls when any tool call
 * was streamed, stop otherwise). `response.failed` throws a structured
 * {@link LlmError}. The Codex backend ends the stream after the terminal
 * event — no `[DONE]` sentinel is required.
 *
 * @module dsh-llm-codex/translate
 */

import { ToolCallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { WireEvent, WireUsage } from './types.ts'
import { codexErrorCode } from './error.ts'

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only */
  callId?: string
  name?: string
}

/**
 * Map the Codex `status`/`incomplete_details` vocabulary to a harness
 * FinishReason.
 * @param status - the terminal response status.
 * @param reason - the incomplete-details reason, when present.
 * @returns the mapped reason; unknown statuses become error finishes.
 */
export function mapFinishReason(status: string, reason?: string): FinishReason {
  switch (status) {
    case 'completed': return { kind: 'stop' }
    case 'incomplete':
      return reason === 'max_output_tokens'
        ? { kind: 'max-tokens' }
        : {
          kind: 'error',
          failure: { message: `model response incomplete: ${reason ?? 'unknown reason'}`, code: 'INCOMPLETE_RESPONSE' },
        }
    default:
      return {
        kind: 'error',
        failure: { message: `model response failed: ${reason ?? status}`, code: 'RESPONSE_FAILED' },
      }
  }
}

/**
 * Map wire usage fields (Responses API shape) to the harness DISJOINT-count
 * convention: cached input tokens are subtracted from the input total.
 * @param usage - wire usage from `response.completed`.
 * @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.input_tokens_details?.cached_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.input_tokens - (cacheRead ?? 0),
    outputTokens: usage.output_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: ToolCallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Consume parsed SSE events (terminated by `response.completed` or
 * `response.failed`) and yield StreamChunks.
 * @param events - parsed event objects from the Codex backend.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are deferred to the terminal event.
 *   A `completed` response with no opened blocks maps to an `EMPTY_RESPONSE` error finish.
 * @throws LlmError `INVALID_RESPONSE` when tool arguments or completion cannot be associated with an opened item; no calls are dispatched.
 */
export async function* translate(events: AsyncIterable<WireEvent>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<string, OpenBlock>()
  const order: OpenBlock[] = []
  let sawToolCall = false
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const event of events) {
    switch (event.type) {
      case 'response.output_item.added':
        if (event.item.type === 'function_call') {
          sawToolCall = true
          let toolBlock = toolBlocks.get(event.item.id)
          if (!toolBlock) {
            toolBlock = open('tool-call')
            toolBlocks.set(event.item.id, toolBlock)
            yield { type: 'block-start', index: toolBlock.index, blockType: 'tool-call' }
          }
          toolBlock.callId = event.item.call_id
          if (typeof event.item.name === 'string') toolBlock.name = event.item.name
        }
        break
      case 'response.content_part.added':
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        break
      case 'response.output_text.delta':
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += event.delta
        yield { type: 'text-delta', index: textBlock.index, text: event.delta }
        break
      case 'response.reasoning_summary_part.added':
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        break
      case 'response.reasoning_summary_text.delta':
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += event.delta
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: event.delta }
        break
      case 'response.function_call_arguments.delta':
      case 'response.function_call_arguments.done': {
        const toolBlock = toolBlocks.get(event.item_id)
        if (!toolBlock) {
          throw new LlmError('Codex tool arguments arrived without a matching function-call item', 'INVALID_RESPONSE')
        }
        if (event.type === 'response.function_call_arguments.done') {
          toolBlock.text = event.arguments
        } else {
          toolBlock.text += event.delta
          yield {
            type: 'tool-call-delta',
            index: toolBlock.index,
            id: ToolCallId(toolBlock.callId ?? ''),
            ...toolBlock.name !== undefined ? { name: toolBlock.name } : {},
            argumentsDelta: event.delta,
          }
        }
        break
      }
      case 'response.output_item.done':
        if (event.item.type === 'function_call') {
          const toolBlock = toolBlocks.get(event.item.id)
          if (!toolBlock) {
            throw new LlmError('Codex function-call completion arrived without a matching item', 'INVALID_RESPONSE')
          }
          toolBlock.callId = event.item.call_id
          toolBlock.name = event.item.name
          if (event.item.arguments !== undefined) toolBlock.text = event.item.arguments
        }
        break
      case 'response.completed':
        for (const block of order) {
          yield { type: 'block-end', index: block.index, block: closeBlock(block) }
        }
        if (event.response.usage) pendingUsage = mapUsage(event.response.usage)
        if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
        const terminal: FinishReason = event.response.status === 'completed'
          ? sawToolCall
            ? { kind: 'tool-calls' }
            : { kind: 'stop' }
          : mapFinishReason(event.response.status, event.response.incomplete_details?.reason)
        yield {
          type: 'finish',
          reason: terminal.kind === 'stop' && order.length === 0
            ? {
              kind: 'error',
              failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
            }
            : terminal,
        }
        return
      case 'response.failed':
        throw new LlmError(
          event.response.error?.message ?? 'OpenAI Codex response failed',
          codexErrorCode(event.response.error) ?? 'TRANSPORT',
        )
      default:
        break
    }
  }

  // The terminal event is guaranteed by the adapter contract.
  throw new LlmError('Codex event stream ended without response.completed or response.failed', 'STREAM_CLOSED')
}
