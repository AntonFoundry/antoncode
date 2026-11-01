import { describe, expect, it } from 'vitest'
import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { DONE } from '../src/sse.ts'
import { mapFinishReason, mapUsage, translate } from '../src/translate.ts'

async function* feed(...payloads: (string | object)[]): AsyncGenerator<string> {
  for (const payload of payloads) {
    yield typeof payload === 'string' ? payload : JSON.stringify(payload)
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/** The live first-chunk signature: role + null content. */
const firstChunk = { choices: [{ delta: { role: 'assistant', content: null } }] }

describe('translate: text', () => {
  it('streams a text block and defers finish to DONE', async () => {
    const chunks = await collect(translate(feed(
      firstChunk,
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      DONE,
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('treats a text-only completion with no finish_reason as stop', async () => {
    const chunks = await collect(translate(feed(firstChunk, { choices: [{ delta: { content: 'ok' } }] }, DONE)))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('translate: reasoning from OpenAI-compatible local servers', () => {
  it('opens a reasoning block on non-empty reasoning_content deltas', async () => {
    const chunks = await collect(translate(feed(
      { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
      { choices: [{ delta: { reasoning_content: 'Let me ' } }] },
      { choices: [{ delta: { reasoning_content: 'think.' } }] },
      { choices: [{ delta: { content: 'Answer.' }, finish_reason: 'stop' }] },
      DONE,
    )))
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'Let me ' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Let me think.' } })
    expect(chunks).toContainEqual({ type: 'block-start', index: 1, blockType: 'text' })
  })
})

describe('translate: tool calls', () => {
  it('assembles streamed tool-call fragments and reports finish tool_calls', async () => {
    const chunks = await collect(translate(feed(
      firstChunk,
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'bash', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }, finish_reason: 'tool_calls' }] },
      DONE,
    )))
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'bash', argumentsDelta: '{"cmd"' })
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
})

describe('translate: usage and finish mapping', () => {
  it('subtracts cached tokens for disjoint harness counts', () => {
    expect(mapUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 30 },
      completion_tokens_details: { reasoning_tokens: 5 },
    })).toEqual({
      inputTokens: 70,
      outputTokens: 20,
      cacheReadTokens: 30,
      reasoningTokens: 5,
    })
  })

  it('maps finish reasons and unknown values to error finishes', () => {
    expect(mapFinishReason('stop')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('tool_calls')).toEqual({ kind: 'tool-calls' })
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
    expect(mapFinishReason('content_filter')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: content_filter', code: 'CONTENT_FILTER' },
    })
  })

  it('reports EMPTY_RESPONSE when the model completes with no content', async () => {
    const chunks = await collect(translate(feed(firstChunk, { choices: [{ delta: {}, finish_reason: 'stop' }] }, DONE)))
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } },
    })
  })

  it('throws MALFORMED_RESPONSE on invalid JSON payloads', async () => {
    await expect(collect(translate(feed(firstChunk, 'not-json', DONE)))).rejects.toThrow(LlmError)
  })
})
