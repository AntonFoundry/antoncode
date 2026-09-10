/**
 * The OpenAI Responses wire protocol (`POST /responses`) for gateways that
 * serve specific models only through it — OpenCode Zen's Muse Spark family
 * answers chat-completions with a bare 500 and completes on `/responses`.
 * The catalog declares the protocol per model (`provider.npm` is the
 * Responses provider), and the adapter branches on it before serializing.
 * Output items map onto the same harness StreamChunk blocks the
 * chat-completions translator emits, so the consuming loop is identical.
 *
 * @module dsh-llm-openai/responses
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError, withoutImageBlocks } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { reasoningEffortWire } from './serialize.ts'
import type { RequestDefaults } from './serialize.ts'
import { DONE } from './sse.ts'

/** Adapter-level request defaults (same shape as the chat-completions path). */
export type { RequestDefaults } from './serialize.ts'

/** One `input` array item of a Responses request. */
type ResponsesInputItem =
  | { role: 'user' | 'assistant'; content: readonly [{ type: 'input_text' | 'output_text'; text: string }] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

/** The Responses request body this adapter sends. */
export interface ResponsesRequest {
  model: string
  input: ResponsesInputItem[]
  stream: true
  instructions?: string
  tools?: readonly { type: 'function'; name: string; description: string; parameters: unknown }[]
  reasoning?: { effort: 'minimal' | 'low' | 'medium' | 'high' }
  temperature?: number
  max_output_tokens?: number
  stop?: string[]
}

/** Join the text blocks of a message (mirrors the chat-completions serializer). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Serialize the conversation into Responses `input` items. The harness puts
 * tool results in user-role messages, so a user message contributes its text
 * as one message item and each tool result as a `function_call_output` item
 * keyed by the originating call id — the same expansion the chat
 * serializer performs with `role: 'tool'` messages.
 * @param messages - the harness conversation, in order.
 * @returns the input items; order preserved.
 */
export function serializeResponsesInput(messages: GenerateOptions['messages']): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = []
  for (const source of messages) {
    const message = { ...source, content: withoutImageBlocks(source.content) }
    if (message.role === 'system') {
      input.push({ role: 'user', content: [{ type: 'input_text', text: flattenText(message.content) }] })
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content)
      if (text.length > 0) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      }
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments })
        }
      }
      continue
    }
    const text = flattenText(message.content)
    if (text.length > 0) {
      input.push({ role: 'user', content: [{ type: 'input_text', text }] })
    }
    for (const block of message.content) {
      if (block.type === 'tool-result') {
        input.push({
          type: 'function_call_output',
          call_id: block.toolCallId,
          // Empty tool output still needs SOME content on the wire.
          output: flattenText(block.content) || '(no output)',
        })
      }
    }
  }
  return input
}

/**
 * Build the full Responses request body. Always streaming; optional fields
 * are omitted rather than sent as null, so provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level reasoning defaults; undefined fields put nothing on the wire.
 * @returns the Responses request body.
 */
export function serializeResponsesRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
): ResponsesRequest {
  const tools = options.tools?.map(tool => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  const effort = options.purpose === 'session-title'
    ? undefined
    : options.reasoningEffort === undefined
      ? defaults.reasoningEffort
      : options.reasoningEffort
  const wireEffort = reasoningEffortWire(effort)

  return {
    model: options.model,
    input: serializeResponsesInput(options.messages),
    stream: true,
    ...options.system !== undefined ? { instructions: options.system } : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...wireEffort === undefined ? {} : { reasoning: { effort: wireEffort } },
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}

/** One SSE event of a Responses stream (the `type` discriminator rides in the data JSON). */
interface ResponsesEvent {
  type?: unknown
  delta?: unknown
  item?: { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown }
  response?: {
    status?: unknown
    incomplete_details?: { reason?: unknown }
    error?: { message?: unknown; code?: unknown } | null
    usage?: {
      input_tokens?: unknown
      output_tokens?: unknown
      input_tokens_details?: { cached_tokens?: unknown }
      output_tokens_details?: { reasoning_tokens?: unknown }
    }
  }
  code?: unknown
  message?: unknown
}

function eventOf(payload: string): ResponsesEvent {
  try {
    return JSON.parse(payload) as ResponsesEvent
  } catch {
    throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
  }
}

function mapUsage(usage: NonNullable<ResponsesEvent['response']>['usage']): TokenUsage | undefined {
  if (typeof usage?.input_tokens !== 'number' || typeof usage?.output_tokens !== 'number') return undefined
  const cached = usage.input_tokens_details?.cached_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  const cacheRead = typeof cached === 'number' ? cached : undefined
  return {
    inputTokens: usage.input_tokens - (cacheRead ?? 0),
    outputTokens: usage.output_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {},
  }
}

/**
 * Consume Responses SSE data payloads and yield StreamChunks. Text arrives
 * as `output_text.delta` events; tool calls arrive whole on their
 * `output_item.done` event (their arguments are not reliable incrementally
 * across gateways). `response.completed` closes every open block, emits
 * usage and the finish, and ends the stream — the Responses protocol sends
 * no `[DONE]` sentinel. `response.failed`, the terminal `error` event, and
 * EOF before completion abort the stream.
 * @param payloads - SSE data payloads from {@link parseSse}.
 * @returns deltas as they arrive; block ends, usage, and finish deferred to the terminal event.
 */
export async function* translateResponses(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: { index: number; text: string } | undefined
  let reasoningBlock: { index: number; text: string } | undefined
  let sawToolCall = false
  let sawTerminal = false

  for await (const payload of payloads) {
    if (payload === DONE) continue
    const event = eventOf(payload)

    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta.length > 0) {
      textBlock ??= { index: nextIndex++, text: '' }
      if (textBlock.text.length === 0) {
        yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
      }
      textBlock.text += event.delta
      yield { type: 'text-delta', index: textBlock.index, text: event.delta }
      continue
    }

    if (
      (event.type === 'response.reasoning_text.delta' || event.type === 'response.reasoning_summary_text.delta')
      && typeof event.delta === 'string' && event.delta.length > 0
    ) {
      reasoningBlock ??= { index: nextIndex++, text: '' }
      if (reasoningBlock.text.length === 0) {
        yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
      }
      reasoningBlock.text += event.delta
      yield { type: 'reasoning-delta', index: reasoningBlock.index, text: event.delta }
      continue
    }

    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      if (typeof event.item.call_id !== 'string' || typeof event.item.name !== 'string'
        || typeof event.item.arguments !== 'string') {
        throw new LlmError('Responses function_call item is missing call_id, name, or arguments', 'MALFORMED_RESPONSE')
      }
      const index = nextIndex++
      sawToolCall = true
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: CallId(event.item.call_id), name: event.item.name, argumentsDelta: event.item.arguments }
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: CallId(event.item.call_id), name: event.item.name, arguments: event.item.arguments },
      }
      continue
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      sawTerminal = true
      const response = event.response ?? {}
      const usage = mapUsage(response.usage)
      const blocks: StreamChunk[] = []
      if (textBlock !== undefined) blocks.push({ type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } })
      if (reasoningBlock !== undefined) {
        blocks.push({ type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } })
      }
      for (const block of blocks) yield block
      if (usage !== undefined) yield { type: 'usage', usage }

      let reason: FinishReason = { kind: 'stop' }
      if (event.type === 'response.failed' || typeof response.error === 'object' && response.error !== null) {
        reason = {
          kind: 'error',
          failure: {
            message: typeof response.error?.message === 'string' ? response.error.message : 'model response failed',
            code: typeof response.error?.code === 'string' ? response.error.code.toUpperCase() : 'RESPONSE_FAILED',
          },
        }
      } else if (event.type === 'response.incomplete') {
        reason = response.incomplete_details?.reason === 'max_output_tokens'
          ? { kind: 'max-tokens' }
          : {
            kind: 'error',
            failure: {
              message: `model response incomplete: ${String(response.incomplete_details?.reason ?? 'unknown')}`,
              code: 'RESPONSE_INCOMPLETE',
            },
          }
      }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && textBlock === undefined && reasoningBlock === undefined && !sawToolCall
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    if (event.type === 'error') {
      throw new LlmError(
        `Responses stream error: ${typeof event.message === 'string' ? event.message : JSON.stringify(payload.slice(0, 200))}`,
        typeof event.code === 'string' ? event.code.toUpperCase() : 'RESPONSE_STREAM_ERROR',
      )
    }
    // Every other event type (output_item.added, response.created,
    // response.in_progress, *.done acknowledgements) carries no harness-visible content.
  }

  if (!sawTerminal) {
    throw new LlmError('Responses SSE stream ended without a terminal response event', 'STREAM_CLOSED')
  }
}
