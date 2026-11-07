import { describe, expect, it } from 'vitest'
import { resolveFailoverConfig } from '../src/failover-config.ts'

const primary = { provider: 'alpha', model: 'primary' }
const backup = { provider: 'beta', model: 'backup' }
const chain = { primary, fallbacks: [backup] }

describe('failover configuration validation', () => {
  it('resolves omission to a disabled policy with explicit finite limits', () => {
    expect(resolveFailoverConfig(undefined)).toEqual({
      enabled: false, chains: [], cooldownMs: 300_000, sameRouteRetries: 1,
      retryDelayMs: 500, maxAttempts: 8, maxElapsedMs: 120_000, contextHeadroomTokens: 8_192,
    })
  })

  it.each([
    ['unknown setting', { enabled: true, chains: [chain], typo: true }],
    ['unknown route field', { chains: [{ primary: { ...primary, modelTypo: 'bad' }, fallbacks: [backup] }] }],
    ['unknown chain field', { chains: [{ ...chain, candidates: [backup] }] }],
    ['empty enabled chain list', { enabled: true }],
    ['duplicate primary', { chains: [chain, chain] }],
    ['cycle to primary', { chains: [{ primary, fallbacks: [primary] }] }],
    ['duplicate candidate', { chains: [{ primary, fallbacks: [backup, backup] }] }],
    ['empty fallbacks', { chains: [{ primary, fallbacks: [] }] }],
    ['empty provider', { chains: [{ primary: { provider: '', model: 'primary' }, fallbacks: [backup] }] }],
    ['empty model', { chains: [{ primary, fallbacks: [{ provider: 'beta', model: '' }] }] }],
    ['zero cooldown', { cooldownMs: 0 }],
    ['negative retries', { sameRouteRetries: -1 }],
    ['unbounded retries', { sameRouteRetries: 11 }],
    ['zero retry delay', { retryDelayMs: 0 }],
    ['zero attempts', { maxAttempts: 0 }],
    ['too many attempts', { maxAttempts: 65 }],
    ['zero elapsed budget', { maxElapsedMs: 0 }],
    ['noninteger elapsed budget', { maxElapsedMs: 1.5 }],
    ['negative context headroom', { contextHeadroomTokens: -1 }],
  ])('rejects %s at activation configuration resolution', (_label, input) => {
    expect(() => resolveFailoverConfig(input)).toThrow()
  })

  it('accepts explicit bounded limits and detaches mutable route settings', () => {
    const input = { enabled: true, chains: [{ primary: { ...primary }, fallbacks: [{ ...backup }] }],
      cooldownMs: 1, sameRouteRetries: 0, retryDelayMs: 1, maxAttempts: 1, maxElapsedMs: 1, contextHeadroomTokens: 0 }
    const resolved = resolveFailoverConfig(input)
    input.chains[0]!.fallbacks[0]!.model = 'changed'
    expect(resolved.chains[0]?.fallbacks[0]).toEqual(backup)
    expect(resolved).toMatchObject({ enabled: true, maxAttempts: 1, contextHeadroomTokens: 0 })
  })
})
