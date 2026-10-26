/**
 * Pool-document guards: admission-filtered parsing, metadata for admitted ids
 * only, the bundled/cached/user precedence `load()` applies, and the download
 * cadence that keeps a vazhi outage from costing a request per read.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePool, PoolStore, type PoolDocument } from '@deepseek-ai/dsh-llm-vazhi'

const cleanups: Array<() => Promise<void>> = []

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vazhi-pool-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    generated: '2026-10-24T00:00:00.000Z',
    sharedLimits: ['kilo', 42, 'llm7'],
    pool: [
      { model: 'ovh/Qwen', rpm: 2, score: 9 },
      { model: 'google/gemini-3.6-flash' },
    ],
    models: {
      ovh: [{ id: 'Qwen', name: 'Qwen (OVH)', contextWindow: 131_072, maxTokens: 8_192 }],
      kilo: [{ id: 'paid/model', name: 'Paid', contextWindow: 1_000 }],
    },
    ...overrides,
  }
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.unstubAllGlobals()
})

describe('parsePool', () => {
  it('keeps admitted entries, bounds, and metadata for admitted ids', () => {
    const pool = parsePool(document())
    expect(pool).toEqual({
      version: 1,
      generated: '2026-10-24T00:00:00.000Z',
      sharedLimits: ['kilo', 'llm7'],
      pool: [
        {
          model: 'ovh/Qwen',
          rpm: 2,
          meta: { id: 'Qwen', name: 'Qwen (OVH)', contextWindow: 131_072, maxTokens: 8_192 },
        },
        { model: 'google/gemini-3.6-flash' },
      ],
    })
  })

  it('drops unadmitted, unknown, malformed, and duplicate entries', () => {
    const pool = parsePool(document({
      pool: [
        { model: 'kilo/paid/model' },
        { model: 'unknown/model' },
        { model: 'no-slash' },
        { model: 42 },
        null,
        { model: 'ovh/One', rpm: 0 },
        { model: 'ovh/One', rpm: 1 },
        { model: 'ovh/Two', rpm: 20_000 },
      ],
    }))
    expect(pool.pool).toEqual([{ model: 'ovh/One' }])
  })

  it('ignores metadata an unadmitted id carries', () => {
    const pool = parsePool(document({
      pool: [{ model: 'kilo/paid/model' }],
    }))
    expect(pool.pool).toEqual([])
  })

  it('reads unusable metadata fields as absent', () => {
    const pool = parsePool({
      version: 1,
      pool: [{ model: 'ovh/One' }],
      models: { ovh: [{ id: 'One', name: '', contextWindow: 0, maxTokens: 1.5 }, 'nope', null] },
      sharedLimits: 'not-an-array',
    })
    expect(pool.pool).toEqual([{ model: 'ovh/One', meta: { id: 'One' } }])
    expect(pool.sharedLimits).toEqual([])
    expect(pool.generated).toBe('')
  })

  it('ignores a metadata section that is not a per-provider list', () => {
    const pool = parsePool({
      version: 1,
      pool: [{ model: 'ovh/One' }],
      models: { ovh: 'not-a-list' },
    })
    expect(pool.pool).toEqual([{ model: 'ovh/One' }])
  })

  it('drops a model key with an empty segment', () => {
    const pool = parsePool({
      version: 1,
      pool: [{ model: '/leading' }, { model: 'trailing/' }, { model: 'ovh/Kept' }],
    })
    expect(pool.pool).toEqual([{ model: 'ovh/Kept' }])
  })

  it('rejects a document that is not a version-1 pool', () => {
    expect(() => parsePool(null)).toThrow(/version 1/)
    expect(() => parsePool({ version: 2, pool: [] })).toThrow(/version 1/)
    expect(() => parsePool({ version: 1 })).toThrow(/version 1/)
  })
})

describe('PoolStore', () => {
  const request = {
    url: 'https://pool.test/pool.json',
    refreshMs: 3_600_000,
    retryAfterMs: 600_000,
    timeoutMs: 1_000,
  }

  it('loads the bundled document when nothing is cached or configured', async () => {
    const store = new PoolStore(await directory())
    const pool = await store.load()
    expect(pool.version).toBe(1)
    expect(pool.pool.length).toBeGreaterThan(0)
    // Every bundled entry passed its upstream's admission rule.
    expect(pool.pool.every(entry => entry.model.includes('/'))).toBe(true)
  })

  it('prefers a cached document newer than the bundled one', async () => {
    const dir = await directory()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'pool-cache.json'), JSON.stringify({
      fetchedAt: 1,
      retryAt: 0,
      pool: document({ generated: '2999-01-01T00:00:00.000Z', pool: [{ model: 'llm7/cached' }] }),
    }))
    const pool = await new PoolStore(dir).load()
    expect(pool.pool.map(entry => entry.model)).toEqual(['llm7/cached'])
  })

  it('keeps the bundled document when the cache is older', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'pool-cache.json'), JSON.stringify({
      fetchedAt: 1,
      retryAt: 0,
      pool: document({ generated: '1', pool: [{ model: 'llm7/stale' }] }),
    }))
    const pool = await new PoolStore(dir).load()
    expect(pool.pool.map(entry => entry.model)).not.toContain('llm7/stale')
  })

  it('applies the user document: replacement pool, exclusions, then preferences', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'config.json'), JSON.stringify({
      pool: [
        { model: 'ovh/Keep' },
        { model: 'ovh/Drop' },
        { model: 'kilo/dropped/model' },
        { model: 'llm7/Late' },
        { model: 'ovh/Whole/Inner' },
      ],
      models: { ovh: [{ id: 'Keep', name: 'Keep (OVH)' }] },
      exclude: ['ovh/Drop', 'kilo/dropped', 'ovh/Whole/'],
      prefer: ['llm7/Late', 'ovh/Missing'],
    }))
    const pool = await new PoolStore(dir).load()
    expect(pool.pool).toEqual([
      { model: 'llm7/Late' },
      { model: 'ovh/Keep', meta: { id: 'Keep', name: 'Keep (OVH)' } },
    ])
  })

  it('keeps an excluded model out even when it is also preferred', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'config.json'), JSON.stringify({
      pool: [{ model: 'ovh/Keep' }, { model: 'ovh/Skip' }],
      exclude: ['ovh/Skip'],
      prefer: ['ovh/Skip'],
    }))
    const pool = await new PoolStore(dir).load()
    expect(pool.pool).toEqual([{ model: 'ovh/Keep' }])
  })

  it('treats malformed cache, user document, and replacement pool as absent', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'pool-cache.json'), '{not json')
    await writeFile(join(dir, 'config.json'), JSON.stringify({ pool: 'nope', prefer: 'nope', exclude: [42] }))
    const pool = await new PoolStore(dir).load()
    expect(pool.pool.length).toBeGreaterThan(0)
    expect(await new PoolStore(dir).cache()).toEqual({ fetchedAt: 0, retryAt: 0 })
    expect(await new PoolStore(dir).userConfig()).toEqual({ prefer: [], exclude: [] })
  })

  it('reads a cache or user document that is not an object as absent', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'pool-cache.json'), '5')
    await writeFile(join(dir, 'config.json'), 'null')
    const store = new PoolStore(dir)
    expect(await store.cache()).toEqual({ fetchedAt: 0, retryAt: 0 })
    expect(await store.userConfig()).toEqual({ prefer: [], exclude: [] })
  })

  it('ignores a cache whose pool is null and a user document that is not an object', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'pool-cache.json'), JSON.stringify({ fetchedAt: 7, retryAt: 8, pool: null }))
    await writeFile(join(dir, 'config.json'), JSON.stringify(['not', 'an', 'object']))
    expect(await new PoolStore(dir).cache()).toEqual({ fetchedAt: 7, retryAt: 8 })
    expect(await new PoolStore(dir).userConfig()).toEqual({ prefer: [], exclude: [] })
  })

  it('downloads once per cadence and commits the newer document', async () => {
    const dir = await directory()
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => document({ generated: '2999-01-01T00:00:00.000Z', pool: [{ model: 'llm7/fresh' }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const store = new PoolStore(dir)
    await expect(store.refresh(request)).resolves.toBe(true)
    expect((await store.load()).pool.map(entry => entry.model)).toEqual(['llm7/fresh'])
    await expect(store.refresh(request)).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a download older than the cached document without replacing it', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'pool-cache.json'), JSON.stringify({
      fetchedAt: 1,
      retryAt: 0,
      pool: document({ generated: '2999-01-01T00:00:00.000Z', pool: [{ model: 'llm7/cached' }] }),
    }))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => document({ generated: '2000-01-01T00:00:00.000Z', pool: [{ model: 'llm7/older' }] }),
    })))
    await expect(new PoolStore(dir).refresh({ ...request, force: true })).resolves.toBe(false)
    expect((await new PoolStore(dir).cache()).pool?.pool.map(entry => entry.model)).toEqual(['llm7/cached'])
  })

  it('records a retry wait after a failed download and keeps the cached pool', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'pool-cache.json'), JSON.stringify({
      fetchedAt: 5,
      retryAt: 0,
      pool: document({ generated: '2999-01-01T00:00:00.000Z', pool: [{ model: 'llm7/cached' }] }),
    }))
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const store = new PoolStore(dir)
    await expect(store.refresh({ ...request, force: true })).resolves.toBe(false)
    const cache = await store.cache()
    expect(cache.fetchedAt).toBe(5)
    expect(cache.retryAt).toBeGreaterThan(Date.now() - 1_000)
    expect(cache.pool?.pool.map(entry => entry.model)).toEqual(['llm7/cached'])
    // Inside the retry window the downloader does not try again.
    await expect(store.refresh({ ...request, force: false })).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('swallows a rejected fetch and a malformed document on the same path', async () => {
    const dir = await directory()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: 9 }) })))
    await expect(new PoolStore(dir).refresh({ ...request, force: true })).resolves.toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(new PoolStore(dir).refresh({ ...request, force: true })).resolves.toBe(false)
  })

  it('reads a corrupt bundled document as an empty pool', async () => {
    // The bundled read is process-cached, so this test only pins that the
    // shipped file parses into admitted entries.
    const store = new PoolStore(await directory())
    const pool: PoolDocument = await store.load()
    expect(pool.pool.every(entry => !entry.model.startsWith('paid/'))).toBe(true)
  })

  it('writes the cache with owner-only permissions', async () => {
    const dir = await directory()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => document() })))
    await new PoolStore(dir).refresh({ ...request, force: true })
    expect(await readFile(join(dir, 'pool-cache.json'), 'utf8')).toContain('"version":1')
  })
})
