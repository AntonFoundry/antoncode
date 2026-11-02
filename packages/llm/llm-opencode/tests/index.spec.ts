/**
 * Config resolution tests for the opencode server plugin: every validation
 * bound and first-load failure.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as LlmOpenCode from '@deepseek-ai/dsh-llm-opencode'
import { resolveAdapterOptions, type Config } from '@deepseek-ai/dsh-llm-opencode'
import { closeMockServers } from './mock-server.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})


describe('resolveAdapterOptions', () => {
  it('resolves defaults for an empty section', () => {
    expect(resolveAdapterOptions({})).toMatchObject({
      passwordEnv: 'OPENCODE_SERVER_PASSWORD',
      autoStart: true,
      transport: 'auto',
      displayName: 'OpenCode Free',
      maxTokens: 16_384,
      defaultContextWindow: 128_000,
    })
    expect(String(resolveAdapterOptions({}).apiKeyEnv)).toBe('OPENCODE_API_KEY')
    expect(resolveAdapterOptions({})).toMatchObject({
      zenBaseURL: 'https://opencode.ai/zen/v1',
      catalogURL: 'https://models.dev',
      catalogRefreshMs: 28_800_000,
    })
    expect('username' in resolveAdapterOptions({})).toBe(false)
    expect(resolveAdapterOptions({}).directory.length).toBeGreaterThan(0)
    expect(resolveAdapterOptions({}).retryPolicy).toMatchObject({ mode: 'normal' })
  })

  it('passes explicit transport fields through untouched', () => {
    expect(resolveAdapterOptions({
      serverURL: 'http://s:9',
      transport: 'service',
      username: 'operator',
      serviceFile: '/custom/state.json',
      passwordFile: '/custom/service.json',
      passwordEnv: 'CUSTOM_PW',
      autoStart: false,
      directory: '/work',
      displayName: 'Custom',
    })).toMatchObject({
      serverURL: 'http://s:9',
      transport: 'service',
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
      { apiKeyEnv: '' },
      { zenBaseURL: '' },
      { catalogURL: '' },
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
    expect(() => resolveAdapterOptions({ catalogRefreshMs: 0 })).toThrow(/catalogRefreshMs/)
    expect(() => resolveAdapterOptions({ catalogRefreshMs: 1.5 })).toThrow(/catalogRefreshMs/)
    expect(() => resolveAdapterOptions({ catalogRefreshMs: MAX_TIMER_DELAY_MS + 1 })).toThrow(/catalogRefreshMs/)
  })

  it('throws at load when the composition entry is invalid', () => {
    const ctx = new Context()
    expect(() => { LlmOpenCode.apply(ctx, { maxTokens: 0 }) }).toThrow(/maxTokens/)
  })
})
