/**
 * Config resolution, registration, and credential behavior of the Vazhi
 * plugin: every validation bound, both credential planes, the bundled and
 * remote pool, the user's `config.json` narrowing, the warm download and its
 * cadence, and settings-driven last-good recovery.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as LlmVazhi from '@deepseek-ai/dsh-llm-vazhi'
import {
  DEFAULT_DISPLAY_NAME,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_POOL_URL,
  DEFAULT_POOL_REFRESH_MS,
  DEFAULT_POOL_RETRY_AFTER_MS,
  DEFAULT_POOL_TIMEOUT_MS,
  DEFAULT_SLOW_FOR_MS,
  DEFAULT_SLOW_START_MS,
  resolveAdapterOptions,
  type Config,
} from '@deepseek-ai/dsh-llm-vazhi'

const NS = settingsNamespace('llm-vazhi')
const cleanups: Array<() => Promise<void> | void> = []

const HELLO_EVENTS = [
  JSON.stringify({ choices: [{ delta: { role: 'assistant', content: null } }] }),
  JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
  '[DONE]',
]

function generation(): Response {
  return new Response(HELLO_EVENTS.map(event => `data: ${event}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function remotePool(models: string[], generated = '2099-01-01T00:00:00.000Z'): Response {
  return new Response(JSON.stringify({
    version: 1,
    generated,
    sharedLimits: [],
    pool: models.map(model => ({ model })),
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

interface Stub {
  readonly fetchMock: ReturnType<typeof vi.fn>
  /** Pool-download calls, which the generation calls never share a path with. */
  poolCalls(): number
  generationCalls(): Array<{ url: string; init: { headers: Record<string, string> } }>
}

function stubFetch(
  answerPool: () => Response = () => new Response('down', { status: 503 }),
  answerChat: () => Response = generation,
): Stub {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.endsWith('/chat/completions')) return answerChat()
    return answerPool()
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    poolCalls: () => fetchMock.mock.calls.filter(call => !String(call[0]).endsWith('/chat/completions')).length,
    generationCalls: () => fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/chat/completions'))
      .map(call => ({ url: String(call[0]), init: call[1] as { headers: Record<string, string> } })),
  }
}

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-vazhi-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {}))
  return dir
}

/** Write the user's narrowing document into `$DSH_HOME/vazhi/config.json`. */
async function userConfig(dir: string, config: unknown): Promise<void> {
  await mkdir(join(dir, 'vazhi'), { recursive: true })
  await writeFile(join(dir, 'vazhi', 'config.json'), JSON.stringify(config))
}

async function boot(config: Config = {}): Promise<Context> {
  const dir = await home()
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LlmVazhi, config)
  return ctx
}

/** Boot with a user pool of `models` under a fresh home. */
async function bootWithPool(models: string[], config: Config = {}): Promise<Context> {
  const dir = await home()
  await userConfig(dir, { pool: models.map(model => ({ model })) })
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LlmVazhi, config)
  return ctx
}

async function modelIds(ctx: Context): Promise<string[]> {
  return (await ctx.llm.listModels('vazhi')).map(model => model.id)
}

async function streamText(ctx: Context, model = 'auto'): Promise<string> {
  let text = ''
  for await (const chunk of ctx.llm.stream({ provider: 'vazhi', model, messages: [] })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

/** The single error finish a failed generation reports. */
async function failureOf(ctx: Context, model = 'auto'): Promise<{ code: string; message: string }> {
  for await (const chunk of ctx.llm.stream({ provider: 'vazhi', model, messages: [] })) {
    if (chunk.type === 'finish' && chunk.reason.kind === 'error') return chunk.reason.failure
  }
  throw new Error('expected an error finish')
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('resolveAdapterOptions', () => {
  it('resolves the documented defaults', async () => {
    const dir = await home()
    vi.stubEnv('DSH_HOME', dir)
    expect(resolveAdapterOptions({})).toMatchObject({
      directory: join(dir, 'vazhi'),
      displayName: DEFAULT_DISPLAY_NAME,
      poolURL: DEFAULT_POOL_URL,
      poolRefreshMs: DEFAULT_POOL_REFRESH_MS,
      poolRetryAfterMs: DEFAULT_POOL_RETRY_AFTER_MS,
      poolTimeoutMs: DEFAULT_POOL_TIMEOUT_MS,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      slowStartMs: DEFAULT_SLOW_START_MS,
      slowForMs: DEFAULT_SLOW_FOR_MS,
      maxTokens: 16_384,
      defaultContextWindow: 128_000,
    })
  })

  it('passes explicit fields through untouched', () => {
    const resolved = resolveAdapterOptions({
      displayName: 'Pool',
      directory: '/tmp/pool',
      poolURL: 'https://pool.test/pool.json',
      poolRefreshMs: 1_000,
      poolRetryAfterMs: 2_000,
      poolTimeoutMs: 3_000,
      maxAttempts: 2,
      slowStartMs: 4_000,
      slowForMs: 5_000,
      maxTokens: 1_024,
      defaultContextWindow: 64_000,
      streamIdleTimeoutMs: 6_000,
      retryPolicy: { mode: 'always' },
    })
    expect(resolved).toMatchObject({
      displayName: 'Pool',
      directory: '/tmp/pool',
      poolURL: 'https://pool.test/pool.json',
      poolRefreshMs: 1_000,
      poolRetryAfterMs: 2_000,
      poolTimeoutMs: 3_000,
      maxAttempts: 2,
      slowStartMs: 4_000,
      slowForMs: 5_000,
      maxTokens: 1_024,
      defaultContextWindow: 64_000,
      streamIdleTimeoutMs: 6_000,
    })
    expect(resolved.retryPolicy.mode).toBe('always')
  })

  it('rejects empty string fields', () => {
    for (const config of [
      { displayName: '' },
      { directory: '' },
      { poolURL: '' },
    ] satisfies Config[]) {
      expect(() => resolveAdapterOptions(config)).toThrow(/non-empty/)
    }
  })

  it('rejects out-of-bound integers', () => {
    for (const field of ['poolRefreshMs', 'poolRetryAfterMs', 'poolTimeoutMs', 'slowStartMs', 'slowForMs'] as const) {
      expect(() => resolveAdapterOptions({ [field]: 0 })).toThrow(new RegExp(field))
      expect(() => resolveAdapterOptions({ [field]: 1.5 })).toThrow(new RegExp(field))
      expect(() => resolveAdapterOptions({ [field]: MAX_TIMER_DELAY_MS + 1 })).toThrow(new RegExp(field))
    }
    expect(() => resolveAdapterOptions({ maxAttempts: 0 })).toThrow(/maxAttempts/)
    expect(() => resolveAdapterOptions({ maxAttempts: 1.5 })).toThrow(/maxAttempts/)
    expect(() => resolveAdapterOptions({ maxAttempts: 101 })).toThrow(/maxAttempts/)
  })

  it('rejects unusable request caps', () => {
    for (const maxTokens of [0, -1, 1.5]) {
      expect(() => resolveAdapterOptions({ maxTokens })).toThrow(/maxTokens/)
    }
    for (const defaultContextWindow of [0, -1, 1.5]) {
      expect(() => resolveAdapterOptions({ defaultContextWindow })).toThrow(/defaultContextWindow/)
    }
    for (const streamIdleTimeoutMs of [0, -1, Number.POSITIVE_INFINITY, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => resolveAdapterOptions({ streamIdleTimeoutMs })).toThrow(/streamIdleTimeoutMs/)
    }
  })

  it('throws at load when the composition entry is invalid', () => {
    expect(() => { LlmVazhi.apply(new Context(), { maxTokens: 0 }) }).toThrow(/maxTokens/)
  })
})

describe('llm-vazhi registration', () => {
  it('registers the route with its selector facts', async () => {
    stubFetch()
    const ctx = await boot()
    expect(ctx.llm.listProviders()).toEqual([{ id: 'vazhi', name: DEFAULT_DISPLAY_NAME }])
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'vazhi',
      displayName: DEFAULT_DISPLAY_NAME,
      settingsNs: NS,
      settingsPath: [],
    })
  })

  it('serves the bundled pool with auto first and anonymous upstreams only', async () => {
    stubFetch()
    const ctx = await boot()
    const ids = await modelIds(ctx)
    expect(ids[0]).toBe('auto')
    expect(ids).toContain('ovh/Qwen3.8-27B')
    // Keyed upstreams buy no availability without a credential.
    expect(ids.some(id => id.startsWith('nvidia/'))).toBe(false)
    expect(ids.some(id => id.startsWith('kilo/'))).toBe(true)
  })

  it('adds a keyed upstream once its environment key exists', async () => {
    stubFetch()
    vi.stubEnv('NVIDIA_API_KEY', 'sk-nvidia')
    const ctx = await bootWithPool(['nvidia/Nemotron'])
    await expect(modelIds(ctx)).resolves.toEqual(['auto', 'nvidia/Nemotron'])
  })

  it('streams through the resolved endpoint, credential, and attribution', async () => {
    const stub = stubFetch()
    vi.stubEnv('NVIDIA_API_KEY', 'sk-nvidia')
    const ctx = await bootWithPool(['nvidia/Nemotron'])
    await expect(streamText(ctx)).resolves.toBe('hello')
    const [generation] = stub.generationCalls()
    expect(generation!.url).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
    expect(generation!.init.headers.authorization).toBe('Bearer sk-nvidia')
    expect(generation!.init.headers['NVCF-POLL-SECONDS']).toBe('5')
    expect(generation!.init.headers['x-deepseek-harness-user-id']).toBeTypeOf('string')
  })

  it('prefers the managed credential store over the environment', async () => {
    const stub = stubFetch()
    vi.stubEnv('NVIDIA_API_KEY', 'from-environment')
    const ctx = await bootWithPool(['nvidia/Nemotron'])
    ctx.provide('credentials', { resolve: async () => ({ value: 'from-store' }) } as never)
    await expect(streamText(ctx)).resolves.toBe('hello')
    expect(stub.generationCalls()[0]!.init.headers.authorization).toBe('Bearer from-store')
  })

  it('reports an unusable stored key instead of sending it', async () => {
    stubFetch()
    const ctx = await bootWithPool(['nvidia/Nemotron'])
    ctx.provide('credentials', { resolve: async () => ({ value: '  ' }) } as never)
    const error = await failureOf(ctx, 'nvidia/Nemotron')
    expect(error.code).toBe('MISSING_CREDENTIAL')
    expect(error.message).toContain('nvidia/Nemotron is not available')
    expect(await modelIds(ctx)).not.toContain('nvidia/Nemotron')
  })

  it('reports an unusable environment key instead of sending it', async () => {
    stubFetch()
    vi.stubEnv('NVIDIA_API_KEY', 'bad\nkey')
    const ctx = await bootWithPool(['nvidia/Nemotron'])
    expect(await modelIds(ctx)).not.toContain('nvidia/Nemotron')
    const error = await failureOf(ctx)
    expect(error.code).toBe('POOL_EMPTY')
  })

  it('treats a store without the entry as absent, without consulting the environment', async () => {
    stubFetch()
    vi.stubEnv('NVIDIA_API_KEY', 'from-environment')
    const ctx = await bootWithPool(['nvidia/Nemotron'])
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    expect(await modelIds(ctx)).not.toContain('nvidia/Nemotron')
  })

  it('treats a blank environment key as absent', async () => {
    stubFetch()
    vi.stubEnv('NVIDIA_API_KEY', '')
    const ctx = await bootWithPool(['nvidia/Nemotron'])
    expect(await modelIds(ctx)).not.toContain('nvidia/Nemotron')
  })

  it('narrows the pool with the user document, keeping exclusions out of prefer', async () => {
    stubFetch()
    const dir = await home()
    await userConfig(dir, { prefer: ['ovh/B'], exclude: ['ovh/A'], pool: [{ model: 'ovh/A' }, { model: 'ovh/B' }] })
    vi.stubEnv('DSH_HOME', dir)
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    await ctx.plugin(LlmVazhi, {})
    await expect(modelIds(ctx)).resolves.toEqual(['auto', 'ovh/B'])
  })

  it('ignores a preferred key the pool does not carry', async () => {
    stubFetch()
    const dir = await home()
    await userConfig(dir, { prefer: ['garbage'], pool: [{ model: 'ovh/Only' }] })
    vi.stubEnv('DSH_HOME', dir)
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    await ctx.plugin(LlmVazhi, { directory: join(dir, 'vazhi') })
    await expect(modelIds(ctx)).resolves.toEqual(['auto', 'ovh/Only'])
    await expect(streamText(ctx)).resolves.toBe('hello')
  })

  it('replaces the bundled pool when the download is newer', async () => {
    const stub = stubFetch(() => remotePool(['ovh/Remote']))
    const ctx = await boot()
    await vi.waitFor(() => { expect(stub.poolCalls()).toBeGreaterThan(0) })
    await vi.waitFor(async () => { expect(await modelIds(ctx)).toEqual(['auto', 'ovh/Remote']) })
  })

  it('fails over through the pool and records the cooldown', async () => {
    const stub = stubFetch(undefined, (() => {
      let calls = 0
      return () => calls++ === 0
        ? new Response('{"error":{"message":"boom"}}', { status: 500 })
        : generation()
    })())
    const dir = await home()
    await userConfig(dir, { pool: [{ model: 'ovh/One' }, { model: 'llm7/Two' }] })
    vi.stubEnv('DSH_HOME', dir)
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    await ctx.plugin(LlmVazhi, {})
    await expect(streamText(ctx)).resolves.toBe('hello')
    expect(stub.generationCalls().map(call => call.url)).toEqual([
      'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
      'https://api.llm7.io/v1/chat/completions',
    ])
    const state = JSON.parse(await readFile(join(dir, 'vazhi', 'state.json'), 'utf8')) as {
      models: Record<string, { failures: number }>
    }
    // The failure marked ovh/One; the success cleared whatever cooled llm7/Two.
    expect(Object.keys(state.models)).toEqual(['ovh/One'])
    expect(state.models['ovh/One']?.failures).toBe(1)
  })

  it('keeps serving the bundled pool when the download fails', async () => {
    stubFetch()
    const ctx = await boot()
    expect(await modelIds(ctx)).toContain('ovh/Qwen3.8-27B')
  })

  it('refreshes the pool on its configured cadence', async () => {
    const stub = stubFetch(() => remotePool(['ovh/Remote']))
    await boot({ poolRefreshMs: 20, poolRetryAfterMs: 1 })
    await vi.waitFor(() => { expect(stub.poolCalls()).toBeGreaterThan(1) })
  })

  it('keeps the last good options when a settings snapshot fails resolution', async () => {
    stubFetch()
    const ctx = await boot()
    const warn = vi.spyOn(ctx.logger, 'error')
    // Schema-valid (a plain string) but resolver-invalid (empty).
    await ctx.settings.update(NS, { displayName: '' })
    expect(warn).toHaveBeenCalled()
    await expect(modelIds(ctx)).resolves.toContain('ovh/Qwen3.8-27B')
  })

  it('re-registers the route in place when the captured retry policy changes', async () => {
    stubFetch()
    const ctx = await boot()
    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })
    await ctx.settings.update(NS, {
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('vazhi')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(observed).toEqual([['vazhi']])
  })

  it('does not re-register for a settings change that keeps the retry policy', async () => {
    stubFetch()
    const ctx = await boot()
    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })
    await ctx.settings.update(NS, { maxTokens: 4_096 })
    expect(observed).toEqual([])
    await expect(ctx.llm.resolveModelInfo('vazhi', 'auto')).resolves
      .toMatchObject({ defaultMaxTokens: 4_096 })
  })

  it('keeps routing when the cooldown file cannot be written', async () => {
    stubFetch(undefined, () => new Response('{"error":{"message":"boom"}}', { status: 500 }))
    const dir = await home()
    const blocker = join(dir, 'blocked')
    await writeFile(blocker, 'occupied')
    vi.stubEnv('DSH_HOME', dir)
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    await ctx.plugin(LlmVazhi, { directory: blocker, maxAttempts: 1 })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const error = await failureOf(ctx)
    expect(error.code).toBe('PROVIDER_EXHAUSTED')
    expect(warn).toHaveBeenCalled()
  })
})
