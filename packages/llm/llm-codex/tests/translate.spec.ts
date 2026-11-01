import { describe, expect, it } from 'vitest'
import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { WireEvent } from '../src/types.ts'
import { mapFinishReason, mapUsage, translate } from '../src/translate.ts'

async function* feed(...payloads: WireEvent[]): AsyncGenerator<WireEvent> {
  for (const payload of payloads) yield payload
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

const completed = (overrides: Partial<Parameters<typeof Object>[0]> = {}) => ({
  type: 'response.completed',
  response: {
    id: 'resp-1',
    status: 'completed',
    ...overrides,
  },
}) as WireEvent

describe('translate: text', () => {
  it('streams text deltas and closes blocks at completed', async () => {
    const chunks = await collect(translate(feed(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-1', role: 'assistant' } },
      { type: 'response.content_part.added', item_id: 'msg-1', part: { type: 'output_text' } },
      { type: 'response.output_text.delta', item_id: 'msg-1', delta: 'Hel' },
      { type: 'response.output_text.delta', item_id: 'msg-1', delta: 'lo' },
      completed({ usage: { input_tokens: 10, output_tokens: 2 } }),
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
})

describe('translate: reasoning summary', () => {
  it('surfaces reasoning_summary deltas as a reasoning block', async () => {
    const chunks = await collect(translate(feed(
      { type: 'response.reasoning_summary_part.added', item_id: 'msg-1', part: { type: 'reasoning_summary' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'msg-1', delta: 'Let me think' },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-2', role: 'assistant' } },
      { type: 'response.content_part.added', item_id: 'msg-2', part: { type: 'output_text' } },
      { type: 'response.output_text.delta', item_id: 'msg-2', delta: 'Answer.' },
      completed(),
    )))
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'Let me think' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Let me think' } })
    expect(chunks).toContainEqual({ type: 'block-start', index: 1, blockType: 'text' })
  })
})

describe('translate: tool calls', () => {
  it('assembles streamed function-call arguments and finishes with tool-calls', async () => {
    const chunks = await collect(translate(feed(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc-1', name: 'bash' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-1', delta: '{"cmd":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-1', delta: '"ls"}' },
      { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc-1', arguments: '{"cmd":"ls"}' },
      completed(),
    )))
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 0, id: 'fc-1', name: 'bash', argumentsDelta: '{"cmd":' })
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'fc-1', name: 'bash', arguments: '{"cmd":"ls"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
})

describe('translate: terminal states', () => {
  it('maps an incomplete max_output_tokens completion to max-tokens', async () => {
    const chunks = await collect(translate(feed(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-1', role: 'assistant' } },
      { type: 'response.content_part.added', item_id: 'msg-1', part: { type: 'output_text' } },
      { type: 'response.output_text.delta', item_id: 'msg-1', delta: 'partial' },
      completed({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    )))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('reports EMPTY_RESPONSE for a completed response with no content', async () => {
    const chunks = await collect(translate(feed(completed())))
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } },
    })
  })

  it('throws a structured LlmError on response.failed', async () => {
    await expect(collect(translate(feed(
      { type: 'response.failed', response: { id: 'r', status: 'failed', error: { code: 'rate_limit_exceeded', message: 'slow down' } } },
    )))).rejects.toMatchObject({ code: 'RATE_LIMIT', message: 'slow down' })
  })
})

describe('translate: usage mapping', () => {
  it('subtracts cached tokens for disjoint harness counts', () => {
    expect(mapUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 30 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 5 },
    })).toEqual({
      inputTokens: 70,
      outputTokens: 20,
      cacheReadTokens: 30,
      reasoningTokens: 5,
    })
  })

  it('maps statuses to finish reasons', () => {
    expect(mapFinishReason('completed')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('incomplete', 'max_output_tokens')).toEqual({ kind: 'max-tokens' })
    expect(mapFinishReason('incomplete', 'interrupted')).toEqual({
      kind: 'error',
      failure: { message: 'model response incomplete: interrupted', code: 'INCOMPLETE_RESPONSE' },
    })
  })

  it('throws when the stream ends without a terminal event', async () => {
    await expect(collect(translate(feed(
      { type: 'response.output_text.delta', item_id: 'msg-1', delta: 'x' },
    )))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})
