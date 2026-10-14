/**
 * Config resolution and registration tests for the opencode server plugin:
 * every validation bound, first-load failure, and the settings-driven
 * last-good recovery plus in-place retry-policy re-registration.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as LlmOpenCode from '@deepseek-ai/dsh-llm-opencode'
import { resolveAdapterOptions, type Config } from '@deepseek-ai/dsh-llm-opencode'
import { closeMockServers, mockOpenCodeServer } from './mock-server.ts'

const NS = settingsNamespace('llm-opencode')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function boot(config: Config): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-opencode-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LlmOpenCode, config)
  return ctx
}

describe('resolveAdapterOptions', () => {
  it('resolves defaults for an empty section', () => {
    expect(resolveAdapterOptions({})).toMatchObject({
      passwordEnv: 'OPENCODE_SERVER_PASSWORD',
      autoStart: true,
      displayName: 'OpenCode Free',
      maxTokens: 16_384,
      defaultContextWindow: 128_000,
    })
    expect('username' in resolveAdapterOptions({})).toBe(false)
    expect(resolveAdapterOptions({}).directory.length).toBeGreaterThan(0)
    expect(resolveAdapterOptions({}).retryPolicy).toMatchObject({ mode: 'normal' })
  })

  it('passes explicit transport fields through untouched', () => {
    expect(resolveAdapterOptions({
      serverURL: 'http://s:9',
      username: 'operator',
      serviceFile: '/custom/state.json',
      passwordFile: '/custom/service.json',
      passwordEnv: 'CUSTOM_PW',
      autoStart: false,
      directory: '/work',
      displayName: 'Custom',
    })).toMatchObject({
      serverURL: 'http://s:9',
      username: 'operator',
      serviceFile: '/custom/state.json',
      passwordFile: '/custom/service.json',
      passwordEnv: 'CUSTOM_PW',
      autoStart: false,
      directory: '/work',
      displayName: 'Custom',
    })
  })

  it('rejects empty string fields', () => {
    for (const config of [
      { serverURL: '' },
      { username: '' },
      { serviceFile: '' },
      { passwordFile: '' },
      { passwordEnv: '' },
      { directory: '' },
      { displayName: '' },
    ] satisfies Config[]) {
      expect(() => resolveAdapterOptions(config)).toThrow(/non-empty/)
    }
  })

  it('rejects out-of-bound numerics', () => {
    expect(() => resolveAdapterOptions({ maxTokens: 0 })).toThrow(/maxTokens/)
    expect(() => resolveAdapterOptions({ maxTokens: 1.5 })).toThrow(/maxTokens/)
    expect(() => resolveAdapterOptions({ maxTokens: -2 })).toThrow(/maxTokens/)
    expect(() => resolveAdapterOptions({ defaultContextWindow: 0 })).toThrow(/defaultContextWindow/)
    expect(() => resolveAdapterOptions({ defaultContextWindow: 1.5 })).toThrow(/defaultContextWindow/)
    expect(() => resolveAdapterOptions({ requestTimeoutMs: 0 })).toThrow(/requestTimeoutMs/)
    expect(() => resolveAdapterOptions({ requestTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(
      /requestTimeoutMs/,
    )
    expect(() => resolveAdapterOptions({ requestTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow(/requestTimeoutMs/)
  })

  it('throws at load when the composition entry is invalid', () => {
    const ctx = new Context()
    expect(() => { LlmOpenCode.apply(ctx, { maxTokens: 0 }) }).toThrow(/maxTokens/)
  })
})

describe('llm-opencode dynamic configuration', () => {
  it('routes the next request with the freshly resolved server URL', async () => {
    const ctx = await boot({ serverURL: 'http://127.0.0.1:1' })
    await expect(ctx.llm.listModels('opencode-free')).resolves.toEqual([])
    await ctx.settings.update(NS, { serverURL: 'http://127.0.0.1:2' })
    await expect(ctx.llm.listModels('opencode-free')).resolves.toEqual([])
  })

  it('keeps the last good options when a snapshot fails beyond-schema validation', async () => {
    const server = await mockOpenCodeServer()
    const ctx = await boot({ serverURL: server.url })
    // Schema-valid (a plain string) but resolver-invalid (empty): the bad
    // snapshot must not move the endpoint.
    await ctx.settings.update(NS, { serverURL: '' })
    await expect(ctx.llm.listModels('opencode-free')).resolves.toEqual([
      { provider: 'opencode-free', id: 'fledge-alpha-free', name: 'Fledge Alpha Free' },
    ])
    await ctx.settings.update(NS, { serverURL: 'http://127.0.0.1:1' })
    await expect(ctx.llm.listModels('opencode-free')).resolves.toEqual([])
  })

  it('re-registers the route in place when the captured retry policy changes', async () => {
    const ctx = await boot({ serverURL: 'http://127.0.0.1:1' })
    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })
    await ctx.settings.update(NS, {
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('opencode-free')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'opencode-free', name: 'OpenCode Free' }])
    expect(observed).toEqual([['opencode-free']])
  })

  it('falls back to the composition entry when settings detach', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-opencode-detach-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    vi.stubEnv('DSH_HOME', dir)
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    const settingsFiber = ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    await settingsFiber
    await ctx.plugin(LlmOpenCode, { serverURL: 'http://127.0.0.1:3' })
    await ctx.settings.update(NS, { serverURL: 'http://127.0.0.1:4' })
    await settingsFiber.dispose()
    await expect(ctx.llm.listModels('opencode-free')).resolves.toEqual([])
  })
})
