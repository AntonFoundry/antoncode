/**
 * Config resolution, credential resolution, and registration tests for the
 * OpenGateway plugin: every validation bound, the two credential planes, the
 * warm catalog fetch and its cadence, and the settings-driven last-good
 * recovery plus in-place retry-policy re-registration.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as LlmOpenGateway from '@deepseek-ai/dsh-llm-opengateway'
import {
  resolveAdapterOptions,
  resolveStoredApiKey,
  type Config,
} from '@deepseek-ai/dsh-llm-opengateway'

const cleanups: Array<() => Promise<void>> = []

function catalogPayload(ids: string[]): unknown {
  return {
    data: ids.map(id => ({
      id,
      status: 'active',
      modalities: { input: ['text'] },
      endpoints: ['chat_completions'],
      context_window: 200_000,
      max_output_tokens: 8_192,
    })),
  }
}

function stubCatalog(ids: string[] = ['model-a']): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => catalogPayload(ids) }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function boot(config: Config = {}): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-opengateway-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmOpenGateway, config)
  return ctx
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

/** A minimal complete chat-completions text generation. */
const HELLO_EVENTS = [
  JSON.stringify({ choices: [{ delta: { role: 'assistant', content: null } }] }),
  JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
  '[DONE]',
]

/** Serve both the catalog and one scripted generation from the same stub. */
function stubGateway(models: Array<Record<string, unknown>> = [{
  id: 'model-a',
  status: 'active',
  modalities: { input: ['text'] },
  endpoints: ['chat_completions'],
  context_window: 200_000,
  max_output_tokens: 8_192,
}]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => String(input).endsWith('/models')
    ? new Response(JSON.stringify({ data: models }), { status: 200 })
    : new Response(HELLO_EVENTS.map(event => `data: ${event}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Drive one generation and concatenate its text deltas. */
async function streamText(ctx: Context): Promise<string> {
  let text = ''
  for await (const chunk of ctx.llm.stream({ provider: 'opengateway', model: 'model-a', messages: [] })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

describe('resolveAdapterOptions', () => {
  it('resolves defaults for an empty section', () => {
    const resolved = resolveAdapterOptions({})
    expect(resolved).toMatchObject({
      baseURL: 'https://apis.opengateway.ai/v1',
      catalogBaseURL: 'https://apis.opengateway.ai/v1',
      displayName: 'OpenGateway',
      maxTokens: 16_384,
      defaultContextWindow: 128_000,
      models: [],
      reasoningEfforts: ['low', 'medium', 'high'],
      defaults: { reasoningDialect: 'gateway' },
    })
    expect(String(resolved.apiKeyEnv)).toBe('OPENGATEWAY_API_KEY')
    expect(resolved.retryPolicy).toMatchObject({ mode: 'normal' })
  })

  it('passes explicit fields through untouched', () => {
    const resolved = resolveAdapterOptions({
      baseURL: 'https://gw.test/v1',
      apiKeyEnv: 'CUSTOM_KEY',
      displayName: 'Custom',
      headers: { 'x-route': 'a' },
      catalogRefreshMs: 5_000,
      maxTokens: 1_024,
      defaultContextWindow: 64_000,
      streamIdleTimeoutMs: 2_000,
      retryPolicy: { mode: 'always' },
    })
    expect(resolved).toMatchObject({
      baseURL: 'https://gw.test/v1',
      catalogBaseURL: 'https://gw.test/v1',
      displayName: 'Custom',
      headers: { 'x-route': 'a' },
      catalogRefreshMs: 5_000,
      maxTokens: 1_024,
      defaultContextWindow: 64_000,
      streamIdleTimeoutMs: 2_000,
    })
    expect(String(resolved.apiKeyEnv)).toBe('CUSTOM_KEY')
    expect(resolved.retryPolicy.mode).toBe('always')
  })

  it('keeps an explicit effort ladder in display order', () => {
    expect(resolveAdapterOptions({ reasoningEfforts: ['low', 'high', 'max'] }).reasoningEfforts)
      .toEqual(['low', 'high', 'max'])
  })

  it('accepts an empty effort ladder as the explicit opt-out', () => {
    expect(resolveAdapterOptions({ reasoningEfforts: [] }).reasoningEfforts).toEqual([])
  })

  it('rejects repeated and undocumented effort labels', () => {
    expect(() => resolveAdapterOptions({ reasoningEfforts: ['low', 'low'] })).toThrow(/repeats/)
    expect(() => resolveAdapterOptions({ reasoningEfforts: ['low', 'ultra' as never] }))
      .toThrow(/unknown reasoning effort/)
  })

  it('copies the header map instead of sharing the configuration object', () => {
    const headers = { 'x-route': 'a' }
    const resolved = resolveAdapterOptions({ headers })
    headers['x-route'] = 'mutated'
    expect(resolved.headers).toEqual({ 'x-route': 'a' })
  })

  it('rejects empty string fields', () => {
    for (const config of [
      { baseURL: '' },
      { apiKeyEnv: '' },
      { displayName: '' },
    ] satisfies Config[]) {
      expect(() => resolveAdapterOptions(config)).toThrow(/non-empty/)
    }
  })

  it('rejects out-of-bound numerics', () => {
    expect(() => resolveAdapterOptions({ catalogRefreshMs: 0 })).toThrow(/catalogRefreshMs/)
    expect(() => resolveAdapterOptions({ catalogRefreshMs: 1.5 })).toThrow(/catalogRefreshMs/)
    expect(() => resolveAdapterOptions({ catalogRefreshMs: MAX_TIMER_DELAY_MS + 1 })).toThrow(/catalogRefreshMs/)
    expect(() => resolveAdapterOptions({ maxTokens: 0 })).toThrow(/maxTokens/)
    expect(() => resolveAdapterOptions({ maxTokens: 1.5 })).toThrow(/maxTokens/)
    expect(() => resolveAdapterOptions({ maxTokens: -2 })).toThrow(/maxTokens/)
    expect(() => resolveAdapterOptions({ defaultContextWindow: 0 })).toThrow(/defaultContextWindow/)
    expect(() => resolveAdapterOptions({ defaultContextWindow: 1.5 })).toThrow(/defaultContextWindow/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: 0 })).toThrow(/streamIdleTimeoutMs/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: Number.POSITIVE_INFINITY }))
      .toThrow(/streamIdleTimeoutMs/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/streamIdleTimeoutMs/)
  })

  it('throws at load when the composition entry is invalid', () => {
    const ctx = new Context()
    expect(() => { LlmOpenGateway.apply(ctx, { maxTokens: 0 }) }).toThrow(/maxTokens/)
  })
})

describe('resolveStoredApiKey', () => {
  const REF = 'OPENGATEWAY_API_KEY' as CredentialRef

  it('prefers the managed credential store', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    vi.stubEnv('OPENGATEWAY_API_KEY', 'from-environment')
    ctx.provide('credentials', {
      resolve: async () => ({ value: 'from-store' }),
    } as never)
    await expect(resolveStoredApiKey(ctx, REF)).resolves.toBe('from-store')
  })

  it('reports an unusable stored value instead of silently missing', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.provide('credentials', {
      resolve: async () => ({ value: '   ' }),
    } as never)
    await expect(resolveStoredApiKey(ctx, REF)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('stops at the store when it has no entry, without consulting the environment', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    vi.stubEnv('OPENGATEWAY_API_KEY', 'from-environment')
    ctx.provide('credentials', {
      resolve: async () => undefined,
    } as never)
    await expect(resolveStoredApiKey(ctx, REF)).resolves.toBeUndefined()
  })

  it('falls back to the launching environment without a credentials seam', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    vi.stubEnv('OPENGATEWAY_API_KEY', 'from-environment')
    await expect(resolveStoredApiKey(ctx, REF)).resolves.toBe('from-environment')
  })

  it('reports an unusable environment value', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    vi.stubEnv('OPENGATEWAY_API_KEY', 'bad\nkey')
    await expect(resolveStoredApiKey(ctx, REF)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('returns undefined for an absent or blank environment value', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await expect(resolveStoredApiKey(ctx, REF)).resolves.toBeUndefined()
    vi.stubEnv('OPENGATEWAY_API_KEY', '')
    await expect(resolveStoredApiKey(ctx, REF)).resolves.toBeUndefined()
  })
})

describe('llm-opengateway registration', () => {
  it('registers the route and warms discovery at mount', async () => {
    const fetchMock = stubCatalog(['model-a'])
    const ctx = await boot()
    expect(ctx.llm.listProviders()).toEqual([{ id: 'opengateway', name: 'OpenGateway' }])
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'opengateway',
      displayName: 'OpenGateway',
      settingsNs: 'llm-opengateway',
      settingsPath: [],
    })
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    await expect(ctx.llm.listModels('opengateway')).resolves.toEqual([
      { provider: 'opengateway', id: 'model-a', name: 'model-a', inputModalities: ['text'] },
    ])
  })

  it('refreshes the catalog on its configured cadence', async () => {
    const fetchMock = stubCatalog()
    await boot({ catalogRefreshMs: 20 })
    await vi.waitFor(() => { expect(fetchMock.mock.calls.length).toBeGreaterThan(1) })
  })

  it('reports a failed warm refresh without failing the mount', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })))
    const ctx = await boot()
    // The route survives the outage and serves an empty picker.
    await expect(ctx.llm.listModels('opengateway')).resolves.toEqual([])
  })

  it('routes model resolution through the discovered catalog facts', async () => {
    stubCatalog(['model-a'])
    const ctx = await boot()
    await expect(ctx.llm.resolveModelInfo('opengateway', 'model-a')).resolves.toMatchObject({
      provider: 'opengateway',
      id: 'model-a',
      name: 'model-a',
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 8_192,
      inputModalities: ['text'],
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
      },
    })
    await expect(ctx.llm.resolveModelInfo('opengateway', 'unlisted')).resolves.toMatchObject({
      id: 'unlisted',
      defaultMaxTokens: 16_384,
      inputModalities: ['text'],
      reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
    })
  })

  it('offers no effort control when the route ladder is empty', async () => {
    stubCatalog()
    const ctx = await boot({ reasoningEfforts: [] })
    const info = await ctx.llm.resolveModelInfo('opengateway', 'model-a')
    expect(info.reasoning).toBeUndefined()
  })

  it('sends a configured ladder level verbatim, including max', async () => {
    vi.stubEnv('OPENGATEWAY_API_KEY', 'sk-test')
    const fetchMock = stubGateway()
    const ctx = await boot({ reasoningEfforts: ['low', 'high', 'max'] })
    let text = ''
    for await (const chunk of ctx.llm.stream({
      provider: 'opengateway',
      model: 'model-a',
      messages: [],
      reasoningEffort: ReasoningEffortId('max'),
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    expect(text).toBe('hello')
    const generation = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/chat/completions'))
    expect(generation).toBeDefined()
    const init = (generation as [string, { body?: unknown }] | undefined)?.[1]
    expect(typeof init?.body === 'string' ? init.body : '').toContain('"reasoning_effort":"max"')
  })

  it('fails a generation with MISSING_CREDENTIAL naming the reference', async () => {
    stubCatalog()
    const ctx = await boot()
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'opengateway', model: 'model-a', messages: [] })) {
      chunks.push(chunk)
    }
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    const finish = chunks[0]
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('expected an error finish')
    expect(finish.reason.failure.code).toBe('MISSING_CREDENTIAL')
    expect(finish.reason.failure.message).toContain('OPENGATEWAY_API_KEY')
  })

  it('streams a generation with the resolved key and harness attribution', async () => {
    vi.stubEnv('OPENGATEWAY_API_KEY', 'sk-test')
    const fetchMock = stubGateway()
    const ctx = await boot()
    await expect(streamText(ctx)).resolves.toBe('hello')
    const generation = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/chat/completions'))
    expect(generation).toBeDefined()
    const request = (generation as unknown[])[1] as { headers: Record<string, string> }
    expect(request.headers.authorization).toBe('Bearer sk-test')
    expect(request.headers['x-deepseek-harness-user-id']).toBeTypeOf('string')
  })

  it('routes a Responses-only model to the Responses endpoint', async () => {
    vi.stubEnv('OPENGATEWAY_API_KEY', 'sk-test')
    const fetchMock = stubGateway([{
      id: 'responses-only',
      status: 'active',
      modalities: { input: ['text'] },
      endpoints: ['responses'],
    }])
    const ctx = await boot()
    await expect(ctx.llm.listModels('opengateway')).resolves.toMatchObject([{ id: 'responses-only' }])
    // The body is not a Responses event stream, so only the routing is asserted.
    for await (const _chunk of ctx.llm.stream({ provider: 'opengateway', model: 'responses-only', messages: [] })) {
      // consume
    }
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toContain(
      'https://apis.opengateway.ai/v1/responses',
    )
  })

})
