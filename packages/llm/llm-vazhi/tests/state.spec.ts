/**
 * Cooldown state: the sanitizing reader, the failure policy that writes it,
 * recovery on success, the slow-starter mark, pool selection, and the atomic
 * file store shared across harness processes.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  choose,
  CooldownStore,
  emptyState,
  noteStart,
  penalize,
  recover,
  readyAt,
  type CooldownEntry,
} from '@deepseek-ai/dsh-llm-vazhi/src/state.ts'

const NOW = 1_700_000_000_000
const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-vazhi-state-'))
}

function entry(until: number, failures = 1, at = NOW, reason = 'rate: 429'): CooldownEntry {
  return { until, failures, reason, at }
}

async function readState(dir: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as unknown
}

describe('CooldownStore.load', () => {
  it('reads a written state back', async () => {
    const dir = await directory()
    const store = new CooldownStore(dir)
    await store.update((state) => {
      state.models['ovh/One'] = entry(NOW + MINUTE, 2)
      state.providers.ovh = entry(NOW + HOUR, 1, NOW, 'auth: 401')
      state.lastLimit.kilo = { at: NOW, model: 'kilo/One:free' }
      state.slow['llm7/Two'] = NOW + MINUTE
    })
    expect(await store.load()).toEqual({
      models: { 'ovh/One': entry(NOW + MINUTE, 2) },
      providers: { ovh: entry(NOW + HOUR, 1, NOW, 'auth: 401') },
      lastLimit: { kilo: { at: NOW, model: 'kilo/One:free' } },
      slow: { 'llm7/Two': NOW + MINUTE },
    })
  })

  it('drops every entry a writer would not have produced', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      models: {
        'ovh/Good': entry(NOW + MINUTE),
        'ovh/NotRecord': 42,
        'ovh/NoUntil': { failures: 1, reason: 'x', at: NOW },
        'ovh/NoFailures': { until: NOW, reason: 'x', at: NOW },
        'ovh/NoAt': { until: NOW, failures: 1, reason: 'x' },
        'ovh/NoReason': { until: NOW, failures: 1, at: NOW },
      },
      providers: 'not-a-record',
      lastLimit: {
        ovh: { at: NOW, model: 'ovh/One' },
        noAt: { model: 'ovh/One' },
        noModel: { at: NOW },
      },
      slow: { 'ovh/Slow': NOW + MINUTE, 'ovh/Bad': 'soon' },
    }))
    expect(await new CooldownStore(dir).load()).toEqual({
      models: { 'ovh/Good': entry(NOW + MINUTE) },
      providers: {},
      lastLimit: { ovh: { at: NOW, model: 'ovh/One' } },
      slow: { 'ovh/Slow': NOW + MINUTE },
    })
  })

  it('reads a non-object document as empty', async () => {
    for (const document of ['[]', 'null', '5']) {
      const dir = await directory()
      await writeFile(join(dir, 'state.json'), document)
      expect(await new CooldownStore(dir).load()).toEqual(emptyState())
    }
  })

  it('reads absent and malformed files as empty', async () => {
    expect(await new CooldownStore(join(await directory(), 'nested')).load()).toEqual(emptyState())
    const dir = await directory()
    await writeFile(join(dir, 'state.json'), '{')
    expect(await new CooldownStore(dir).load()).toEqual(emptyState())
  })
})

describe('CooldownStore.update', () => {
  it('creates a nested directory and commits the state', async () => {
    const dir = join(await directory(), 'vazhi')
    await new CooldownStore(dir).update((state) => {
      state.slow['ovh/One'] = NOW
    })
    expect(await readState(dir)).toEqual({
      models: {},
      providers: {},
      lastLimit: {},
      slow: { 'ovh/One': NOW },
    })
  })

  it('treats a missing warning handler as silence', async () => {
    const dir = await directory()
    const store = new CooldownStore(dir)
    await store.update((state) => {
      state.slow['ovh/One'] = NOW
    })
    expect((await store.load()).slow).toEqual({ 'ovh/One': NOW })

    const parent = await directory()
    const blocker = join(parent, 'state.json')
    await writeFile(blocker, 'occupied')
    await expect(new CooldownStore(blocker).update((state) => {
      state.slow['ovh/One'] = NOW
    })).resolves.toBeUndefined()
  })

  it('warns instead of failing when the write cannot land', async () => {
    const parent = await directory()
    const blocker = join(parent, 'state.json')
    await writeFile(blocker, 'occupied')
    const onWarning = vi.fn()
    await new CooldownStore(blocker, onWarning).update((state) => {
      state.slow['ovh/One'] = NOW
    })
    expect(onWarning).toHaveBeenCalledOnce()
    expect(onWarning.mock.calls[0]![0]).toBeInstanceOf(Error)
    expect(await readFile(blocker, 'utf8')).toBe('occupied')
  })
})

describe('penalize', () => {
  it('doubles the class cooldown with each consecutive failure', () => {
    const state = emptyState()
    expect(penalize(state, 'ovh/One', '429 too many requests', NOW)).toBe(30 * SECOND)
    expect(penalize(state, 'ovh/One', '429 too many requests', NOW)).toBe(MINUTE)
    expect(penalize(state, 'ovh/One', '429 too many requests', NOW)).toBe(2 * MINUTE)
    expect(state.models['ovh/One']).toEqual(entry(NOW + 2 * MINUTE, 3, NOW, 'rate: 429 too many requests'))
  })

  it('caps growth at the class maximum', () => {
    const state = emptyState()
    state.models['ovh/One'] = entry(NOW, 40)
    expect(penalize(state, 'ovh/One', '429 rate limit', NOW)).toBe(30 * MINUTE)
  })

  it('honours a stated delay with the five-second floor', () => {
    const state = emptyState()
    expect(penalize(state, 'ovh/One', '429 rate limit, retry after 1s', NOW)).toBe(5 * SECOND)
    expect(penalize(state, 'ovh/Two', '429 rate limit, retry after 90s', NOW)).toBe(90 * SECOND)
  })

  it('cools the whole upstream on an auth failure', () => {
    const state = emptyState()
    penalize(state, 'nvidia/One', '401 unauthorized', NOW)
    expect(state.providers.nvidia?.until).toBe(NOW + 6 * HOUR)
    expect(state.providers.nvidia?.reason).toContain('auth:')
  })

  it('cools a shared-limit upstream after a second model reports within the window', () => {
    const state = emptyState()
    penalize(state, 'kilo/One:free', '429 rate limit', NOW, ['kilo'])
    expect(state.lastLimit.kilo).toEqual({ at: NOW, model: 'kilo/One:free' })
    expect(state.providers.kilo).toBeUndefined()

    penalize(state, 'kilo/Two:free', '429 rate limit', NOW + MINUTE, ['kilo'])
    expect(state.providers.kilo?.until).toBe(NOW + MINUTE + 30 * SECOND)
    expect(state.providers.kilo?.reason).toContain('provider-wide')
    expect(state.lastLimit.kilo).toEqual({ at: NOW + MINUTE, model: 'kilo/Two:free' })
  })

  it('leaves an upstream alone for a repeat report from the same model', () => {
    const state = emptyState()
    penalize(state, 'kilo/One:free', '429 rate limit', NOW, ['kilo'])
    penalize(state, 'kilo/One:free', '429 rate limit', NOW + SECOND, ['kilo'])
    expect(state.providers.kilo).toBeUndefined()
  })

  it('ignores a shared-limit report outside the window', () => {
    const state = emptyState()
    penalize(state, 'kilo/One:free', '429 rate limit', NOW, ['kilo'])
    penalize(state, 'kilo/Two:free', '429 rate limit', NOW + 3 * MINUTE, ['kilo'])
    expect(state.providers.kilo).toBeUndefined()
  })

  it('does not widen a non-shared failure kind to the upstream', () => {
    const state = emptyState()
    penalize(state, 'kilo/One:free', '404 not found', NOW, ['kilo'])
    expect(state.providers.kilo).toBeUndefined()
    expect(state.lastLimit.kilo).toBeUndefined()
  })

  it('ignores a shared-limits list that does not name the provider', () => {
    const state = emptyState()
    penalize(state, 'kilo/One:free', '429 rate limit', NOW, ['llm7'])
    expect(state.lastLimit.kilo).toBeUndefined()
  })

  it('keeps the later end when a shorter cooldown follows a longer one', () => {
    const state = emptyState()
    state.models['ovh/One'] = entry(NOW + HOUR, 4)
    penalize(state, 'ovh/One', '429 rate limit', NOW + SECOND)
    expect(state.models['ovh/One']).toEqual(entry(NOW + HOUR, 5, NOW + SECOND, 'rate: 429'))
  })

  it('collapses whitespace and truncates long provider text in the reason', () => {
    const state = emptyState()
    penalize(state, 'ovh/One', 'x'.repeat(400), NOW)
    expect(state.models['ovh/One']!.reason).toBe(`other: ${'x'.repeat(160)}`)
    penalize(state, 'ovh/Two', 'a\n\n  b', NOW)
    expect(state.models['ovh/Two']!.reason).toBe('other: a b')
  })
})

describe('recover', () => {
  it('clears what predates the successful attempt', () => {
    const state = emptyState()
    state.models['ovh/One'] = entry(NOW, 1, NOW - SECOND)
    state.providers.ovh = entry(NOW, 1, NOW - SECOND)
    state.lastLimit.ovh = { at: NOW - SECOND, model: 'ovh/One' }
    recover(state, 'ovh/One', NOW)
    expect(state).toEqual(emptyState())
  })

  it('keeps failures newer than the successful attempt', () => {
    const state = emptyState()
    state.models['ovh/One'] = entry(NOW, 1, NOW + SECOND)
    state.providers.ovh = entry(NOW, 1, NOW + SECOND)
    state.lastLimit.ovh = { at: NOW + SECOND, model: 'ovh/One' }
    recover(state, 'ovh/One', NOW)
    expect(state.models['ovh/One']).toBeDefined()
    expect(state.providers.ovh).toBeDefined()
    expect(state.lastLimit.ovh).toBeDefined()
  })

  it('clears nothing when no failure was recorded', () => {
    const state = emptyState()
    recover(state, 'ovh/One', NOW)
    expect(state).toEqual(emptyState())
  })
})

describe('readyAt', () => {
  it('reports the later of the model and upstream cooldowns', () => {
    const state = emptyState()
    expect(readyAt(state, 'ovh/One')).toBe(0)
    state.models['ovh/One'] = entry(NOW + MINUTE)
    expect(readyAt(state, 'ovh/One')).toBe(NOW + MINUTE)
    state.providers.ovh = entry(NOW + 2 * MINUTE)
    expect(readyAt(state, 'ovh/One')).toBe(NOW + 2 * MINUTE)
    expect(readyAt(state, 'ovh/Other')).toBe(NOW + 2 * MINUTE)
  })
})

describe('noteStart', () => {
  it('marks a slow starter and clears expired marks', () => {
    const state = emptyState()
    state.slow['ovh/Stale'] = NOW
    noteStart(state, 'ovh/One', 20_000, NOW, 15_000, 10 * MINUTE)
    expect(state.slow).toEqual({ 'ovh/One': NOW + 10 * MINUTE })
  })

  it('does not shorten an existing mark and ignores a start at the threshold', () => {
    const state = emptyState()
    state.slow['ovh/One'] = NOW + HOUR
    noteStart(state, 'ovh/One', 20_000, NOW, 15_000, 10 * MINUTE)
    expect(state.slow['ovh/One']).toBe(NOW + HOUR)
    noteStart(state, 'ovh/Two', 15_000, NOW, 15_000, 10 * MINUTE)
    expect(state.slow['ovh/Two']).toBeUndefined()
  })
})

describe('choose', () => {
  const pool = ['ovh/One', 'ovh/Two', 'llm7/Three']

  it('takes the first ready model in pool order', () => {
    expect(choose(pool, emptyState(), NOW)).toEqual({ model: 'ovh/One', waitMs: 0 })
  })

  it('skips cooling models and the attempt that just failed', () => {
    const state = emptyState()
    state.models['ovh/One'] = entry(NOW + MINUTE)
    expect(choose(pool, state, NOW)).toEqual({ model: 'ovh/Two', waitMs: 0 })
    expect(choose(pool, state, NOW, 'ovh/Two')).toEqual({ model: 'llm7/Three', waitMs: 0 })
  })

  it('retries the failed model when it is the only ready one', () => {
    const state = emptyState()
    state.models['ovh/Two'] = entry(NOW + MINUTE)
    state.models['llm7/Three'] = entry(NOW + MINUTE)
    expect(choose(pool, state, NOW, 'ovh/One')).toEqual({ model: 'ovh/One', waitMs: 0 })
  })

  it('puts slow starters behind the rest, and last when nothing else is ready', () => {
    const state = emptyState()
    noteStart(state, 'ovh/One', 20_000, NOW, 15_000, 10 * MINUTE)
    expect(choose(pool, state, NOW)).toEqual({ model: 'ovh/Two', waitMs: 0 })
    state.models['ovh/Two'] = entry(NOW + MINUTE)
    state.models['llm7/Three'] = entry(NOW + MINUTE)
    expect(choose(pool, state, NOW)).toEqual({ model: 'ovh/One', waitMs: 0 })
  })

  it('reports the earliest wait when every model is cooling down', () => {
    const state = emptyState()
    state.models['ovh/One'] = entry(NOW + 3 * MINUTE)
    state.models['ovh/Two'] = entry(NOW + MINUTE)
    state.models['llm7/Three'] = entry(NOW + 2 * MINUTE)
    expect(choose(pool, state, NOW)).toEqual({ waitMs: MINUTE })
  })

  it('never reports a negative wait for an already-free model', () => {
    const state = emptyState()
    state.models['ovh/One'] = entry(NOW - MINUTE)
    state.models['ovh/Two'] = entry(NOW - MINUTE)
    state.providers.ovh = entry(NOW - MINUTE)
    expect(choose(['ovh/One', 'ovh/Two'], state, NOW)).toEqual({ model: 'ovh/One', waitMs: 0 })
  })

  it('reports no pick and no wait for an empty pool', () => {
    expect(choose([], emptyState(), NOW)).toEqual({ waitMs: 0 })
  })
})
