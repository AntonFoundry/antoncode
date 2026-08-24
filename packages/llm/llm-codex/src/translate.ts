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

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { WireEvent, WireUsage } from './types.ts'

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
export function mapFinishReason(status: string, reason?: string): FinishReason {  switch (status) {
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

/** Map a Codex stream error code to a harness LlmError code. */
function streamErrorCode(code: string | undefined): string {
  switch (code) {
    case 'authentication_error':
    case 'invalid_api_key': return 'AUTH'
    case 'rate_limit_exceeded': return 'RATE_LIMIT'
    case 'insufficient_quota':
    case 'billing_not_active': return 'QUOTA_EXCEEDED'
    case 'context_length_exceeded': return 'CONTEXT_WINDOW_EXCEEDED'
    case 'invalid_request_error': return 'INVALID_REQUEST'
    default: return 'TRANSPORT'
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
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
 */
export async function* translate(events: AsyncIterable<WireEvent>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  let toolBlock: OpenBlock | undefined
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
        if (event.item.type === 'function_call' && !toolBlock) {
          sawToolCall = true
          toolBlock = open('tool-call')
          toolBlock.callId = event.item.id
          if (typeof event.item.name === 'string') toolBlock.name = event.item.name
          yield { type: 'block-start', index: toolBlock.index, blockType: 'tool-call' }
        }
        break
      case 'response.content_part.added':
        if (event.part.type === 'output_text' && !textBlock) {
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
        sawToolCall = true
        if (!toolBlock) {
          toolBlock = open('tool-call')
          toolBlock.callId = event.item_id
          yield { type: 'block-start', index: toolBlock.index, blockType: 'tool-call' }
        }
        toolBlock.text += event.delta
        yield {
          type: 'tool-call-delta',
          index: toolBlock.index,
          id: CallId(toolBlock.callId ?? ''),
          ...toolBlock.name !== undefined ? { name: toolBlock.name } : {},
          argumentsDelta: event.delta,
        }
        break
      case 'response.function_call_arguments.done':
        if (toolBlock) toolBlock.text = event.arguments
        break
      case 'response.output_item.done':
        // A text item closes here if no explicit output_text.done arrived.
        if (event.item.type === 'message' && textBlock) {
          // keep open; the completed event flushes ordering
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
          streamErrorCode(event.response.error?.code),
        )
      default:
        break
    }
  }

  // The terminal event is guaranteed by the adapter contract.
  throw new LlmError('Codex event stream ended without response.completed or response.failed', 'STREAM_CLOSED')
}
