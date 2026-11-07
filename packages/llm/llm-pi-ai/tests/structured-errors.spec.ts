import { afterEach, describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

async function failureOf(
  response: Parameters<typeof mockServer>[0][number],
  api = 'openai-completions',
): Promise<FinishReason> {
  const server = await mockServer([response])
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ gateway: {
      api, baseURL: server.url,
      models: [{ id: 'm', contextWindow: 8192, maxTokens: 1024 }],
    } }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
  try {
    for await (const chunk of adapter.stream({ provider: 'gateway', model: 'm', messages: [] })) {
      if (chunk.type === 'finish') return chunk.reason
    }
    throw new Error('missing finish')
  } catch (error) {
    // The adapter may throw typed failures or emit a terminal error chunk.
    if (error instanceof LlmError) return { kind: 'error', failure: error.failure }
    throw error
  }
}

describe('pi-ai structured provider errors', () => {
  it.each([
    [429, 'insufficient_quota', 'invalid_request_error', 'QUOTA'],
    [400, 'billing_not_active', undefined, 'QUOTA'],
    [503, 'server_overloaded', undefined, 'OVERLOADED'],
    [529, undefined, 'overloaded_error', 'OVERLOADED'],
    [404, 'model_not_found', 'invalid_request_error', 'MODEL_UNAVAILABLE'],
    [503, 'model_unavailable', undefined, 'MODEL_UNAVAILABLE'],
    [400, 'invalid_request_error', 'model_unavailable', 'INVALID_REQUEST'],
    [401, 'model_unavailable', undefined, 'AUTH'],
    [403, 'insufficient_quota', undefined, 'AUTH'],
    [400, 'context_length_exceeded', 'overloaded_error', 'CONTEXT_WINDOW_EXCEEDED'],
    [400, 'model_unavailable', 'authentication_error', 'AUTH'],
    [400, 'model_unavailable', 'context_length_exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
    [400, undefined, 'invalid_request_error', 'INVALID_REQUEST'],
    [404, undefined, undefined, 'PI_AI_ERROR'],
    [503, undefined, undefined, 'SERVER'],
  ])('maps HTTP %s code %s type %s to %s', async (status, code, type, expected) => {
    const reason = await failureOf({ status, body: JSON.stringify({ error: { code, type, message: 'opaque rejection' } }) })
    expect(reason).toMatchObject({ kind: 'error', failure: { code: expected, status } })
  })

  it('retains HTTP retry delay and request id without extracting them from display text', async () => {
    const reason = await failureOf({
      status: 429,
      headers: { 'retry-after': '2', 'x-request-id': 'req-pi-test' },
      body: JSON.stringify({ error: { code: 'insufficient_quota', message: 'opaque rejection' } }),
    })
    expect(reason).toMatchObject({ kind: 'error', failure: {
      code: 'QUOTA', status: 429, providerRetryAfterMs: 2000, requestId: 'req-pi-test',
    } })
  })

  it.each(['openai-completions', 'openai-responses', 'anthropic-messages'])('maps HTTP facts for %s', async (api) => {
    expect(await failureOf({ status: 503, body: JSON.stringify({ error: { type: 'overloaded_error', message: 'opaque rejection' } }) }, api))
      .toMatchObject({ kind: 'error', failure: { code: 'OVERLOADED', status: 503 } })
  })

  it.each([

    ['openai-responses', { type: 'response.failed', response: { error: { code: 'insufficient_quota', message: 'opaque rejection' } } }, 'QUOTA'],
    ['anthropic-messages', { type: 'error', error: { type: 'overloaded_error', message: 'opaque rejection' } }, 'OVERLOADED'],
    ['anthropic-messages', { type: 'error', error: { type: 'invalid_request_error', message: 'model_unavailable overloaded_error' } }, 'INVALID_REQUEST'],
  ])('maps structured SSE from %s', async (api, event, code) => {
    const reason = await failureOf({ events: [{ event: event.type, data: JSON.stringify(event) }] }, api)
    expect(reason).toMatchObject({ kind: 'error', failure: { code } })
  })

  it('keeps flattened OpenAI SDK error SSE unclassified when the SDK consumes its structured code', async () => {
    const event = { type: 'error', code: 'model_not_found', message: 'opaque rejection' }
    expect(await failureOf({ events: [{ event: 'error', data: JSON.stringify(event) }] }, 'openai-responses'))
      .toMatchObject({ kind: 'error', failure: { code: 'PI_AI_ERROR' } })
  })

  it('preserves context overflow wording despite a generic invalid-request type', async () => {
    expect(await failureOf({ status: 400, body: JSON.stringify({ error: {
      type: 'invalid_request_error', message: 'input exceeds the model context window limit',
    } }) }))
      .toMatchObject({ kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 } })
  })

  it('does not infer availability or overload from provider prose', async () => {
    expect(await failureOf({ status: 400, body: JSON.stringify({ error: { message: 'model_unavailable overloaded_error' } }) }))
      .toMatchObject({ kind: 'error', failure: { code: 'INVALID_REQUEST', status: 400 } })
  })
})
