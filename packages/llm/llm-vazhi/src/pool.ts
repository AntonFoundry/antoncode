/**
 * The Vazhi pool document: bundled, remotely refreshed, and narrowed by the
 * user's own `config.json`.
 *
 * A pool document is untrusted input. Only a model id admitted by its
 * provider's rule enters the pool, endpoints stay in {@link PROVIDERS}, and
 * the metadata attached to an entry is read from the same document only for
 * an id that already passed admission. A tampered paste can therefore change
 * the order of free models, never where a prompt is sent.
 *
 * @module @deepseek-ai/dsh-llm-vazhi/pool
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { allowedInPool, splitModelKey } from './providers.ts'

/** One admitted pool model, in preference order. */
export interface PoolEntry {
  /** `provider/model` as selected on the route and stored in cooldown state. */
  readonly model: string
  /** Requests per minute the pool document asks the router to respect. */
  readonly rpm?: number
  /** Metadata the pool document carries for this admitted id. */
  readonly meta?: PoolModelMeta
}

/** Display and capacity facts a pool document may carry for one model. */
export interface PoolModelMeta {
  /** Wire model id within the upstream. */
  readonly id: string
  /** Selector label from the pool document. */
  readonly name?: string
  /** Known combined request/response context capacity. */
  readonly contextWindow?: number
  /** Per-request output cap. */
  readonly maxTokens?: number
}

/** A validated pool document. */
export interface PoolDocument {
  readonly version: 1
  /** Generation timestamp; the newer document wins between bundled and cached. */
  readonly generated: string
  /** Upstreams whose rate limits are shared across their models. */
  readonly sharedLimits: readonly string[]
  readonly pool: readonly PoolEntry[]
}

/** The user's narrowing document (`config.json`), all fields optional. */
export interface UserPoolConfig {
  /** Model keys moved to the front of the pool. */
  readonly prefer: readonly string[]
  /** Model keys or provider prefixes removed from the pool. */
  readonly exclude: readonly string[]
  /** A complete replacement pool, validated exactly like a downloaded one. */
  readonly pool?: unknown
  /** Metadata for a replacement pool, validated by the same admission rules. */
  readonly models?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Metadata for admitted ids only: an unadmitted id contributes nothing. */
function readModelMetadata(raw: unknown): Map<string, PoolModelMeta> {
  const metadata = new Map<string, PoolModelMeta>()
  if (!isRecord(raw)) return metadata
  for (const [provider, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue
    for (const value of entries) {
      if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) continue
      if (!allowedInPool(provider, value.id)) continue
      const contextWindow = positiveInteger(value.contextWindow)
      const maxTokens = positiveInteger(value.maxTokens)
      metadata.set(`${provider}/${value.id}`, {
        id: value.id,
        ...typeof value.name === 'string' && value.name.length > 0 ? { name: value.name } : {},
        ...contextWindow === undefined ? {} : { contextWindow },
        ...maxTokens === undefined ? {} : { maxTokens },
      })
    }
  }
  return metadata
}

/**
 * Validate one pool document, dropping every entry its provider's free-tier
 * rule does not admit.
 * @param raw - parsed JSON from the bundled file, the download, or the user's document.
 * @returns the admitted pool, in document order, with metadata for admitted ids.
 * @throws when the document is not a version-1 Vazhi pool.
 */
export function parsePool(raw: unknown): PoolDocument {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.pool)) {
    throw new Error('llm-vazhi: not a Vazhi pool document (version 1)')
  }
  const metadata = readModelMetadata(raw.models)
  const pool: PoolEntry[] = []
  const seen = new Set<string>()
  for (const value of raw.pool) {
    if (!isRecord(value) || typeof value.model !== 'string' || !value.model.includes('/')) continue
    const model = value.model
    if (seen.has(model)) continue
    try {
      const [provider, id] = splitModelKey(model)
      if (!allowedInPool(provider, id)) continue
    } catch {
      // Only the key's own separator can fail here: no slash means no upstream.
      continue
    }
    // The published pool's own bound: a larger rpm is not a plausible free-tier
    // quota, so the entry is unusable rather than trusted without one.
    const rpm = positiveInteger(value.rpm)
    if (rpm !== undefined && rpm >= 10_000) continue
    seen.add(model)
    const meta = metadata.get(model)
    pool.push({
      model,
      ...rpm === undefined ? {} : { rpm },
      ...meta === undefined ? {} : { meta },
    })
  }
  return {
    version: 1,
    generated: typeof raw.generated === 'string' ? raw.generated : '',
    sharedLimits: Array.isArray(raw.sharedLimits)
      ? raw.sharedLimits.filter((value): value is string => typeof value === 'string')
      : [],
    pool,
  }
}

/** One cached download plus its retry bookkeeping. */
interface PoolCache {
  readonly fetchedAt: number
  readonly retryAt: number
  readonly pool?: PoolDocument
}

const EMPTY_POOL: PoolDocument = Object.freeze({ version: 1, generated: '', sharedLimits: [], pool: [] })

/** Bundled-document read, resolved once per process: the shipped file never changes under a run. */
let bundled: Promise<PoolDocument> | undefined

async function readBundled(): Promise<PoolDocument> {
  bundled ??= (async () => {
    try {
      const raw = await readFile(new URL('../pool.json', import.meta.url), 'utf8')
      return parsePool(JSON.parse(raw) as unknown)
    } catch {
      // A missing or corrupt bundled file costs the bundled entries only; the
      // download cache and the user's document still supply a pool.
      /* v8 ignore next 2 -- the shipped pool.json is present and valid in every build; the guard covers a corrupted install. */
      return EMPTY_POOL
    }
  })()
  return bundled
}

/** One remote refresh's request facts. */
export interface PoolRefreshRequest {
  /** Where the pool document is downloaded from. */
  readonly url: string
  /** How long one successful download serves before the next attempt. */
  readonly refreshMs: number
  /** How long a failed download waits before retrying. */
  readonly retryAfterMs: number
  /** Fetch regardless of the cadence and the retry wait. */
  readonly force?: boolean
  /** Bound on the download itself. */
  readonly timeoutMs: number
}

/**
 * The pool files under one directory: `pool-cache.json` for the download and
 * `config.json` for the user's narrowing choices.
 */
export class PoolStore {
  readonly #directory: string

  /** @param directory - directory holding the pool cache and user configuration. */
  constructor(directory: string) {
    this.#directory = directory
  }

  /**
   * The cached download and its retry state; malformed content reads as absent.
   * @returns the cache, with `pool` absent when nothing usable was stored.
   */
  async cache(): Promise<PoolCache> {
    try {
      const raw = JSON.parse(await readFile(join(this.#directory, 'pool-cache.json'), 'utf8')) as unknown
      if (!isRecord(raw)) return { fetchedAt: 0, retryAt: 0 }
      const fetchedAt = positiveInteger(raw.fetchedAt) ?? 0
      const retryAt = positiveInteger(raw.retryAt) ?? 0
      if (raw.pool === undefined || raw.pool === null) return { fetchedAt, retryAt }
      return { fetchedAt, retryAt, pool: parsePool(raw.pool) }
    } catch {
      // Absence, unreadable permissions, and malformed JSON all mean "no usable cache".
      return { fetchedAt: 0, retryAt: 0 }
    }
  }

  /**
   * The user's narrowing document; absent or malformed content narrows nothing.
   * @returns the user's `prefer` and `exclude` lists plus any replacement pool.
   */
  async userConfig(): Promise<UserPoolConfig> {
    try {
      const raw = JSON.parse(await readFile(join(this.#directory, 'config.json'), 'utf8')) as unknown
      if (!isRecord(raw)) return { prefer: [], exclude: [] }
      return {
        prefer: Array.isArray(raw.prefer) ? raw.prefer.filter((value): value is string => typeof value === 'string') : [],
        exclude: Array.isArray(raw.exclude) ? raw.exclude.filter((value): value is string => typeof value === 'string') : [],
        ...Array.isArray(raw.pool) ? { pool: raw.pool } : {},
        ...raw.models === undefined ? {} : { models: raw.models },
      }
    } catch {
      // Same reason as the cache: a broken or missing user document means the defaults.
      return { prefer: [], exclude: [] }
    }
  }

  /**
   * Download the pool when the cadence allows it. Never fatal: a failure is
   * recorded as a retry wait and the previous document keeps serving.
   * @param request - cadence, retry wait, download bound, and target URL.
   * @returns true when a newer document replaced the cache.
   */
  async refresh(request: PoolRefreshRequest): Promise<boolean> {
    const cached = await this.cache()
    const now = Date.now()
    if (request.force !== true
      && (now < cached.retryAt || (cached.fetchedAt > 0 && now - cached.fetchedAt < request.refreshMs))) {
      return false
    }
    try {
      const response = await fetch(request.url, {
        headers: { 'user-agent': 'deepseek-harness/llm-vazhi', accept: 'application/json' },
        signal: AbortSignal.timeout(request.timeoutMs),
      })
      if (!response.ok) throw new Error(`llm-vazhi: pool download failed with ${response.status}`)
      const next = parsePool(await response.json() as unknown)
      if ((cached.pool?.generated ?? '') > next.generated) return false
      await this.#writeCache({ fetchedAt: now, retryAt: 0, pool: next })
      return true
    } catch {
      // The remote pool is an optional freshness upgrade. Record the retry
      // wait so an outage costs one request per window, not one per read.
      try {
        await this.#writeCache({
          fetchedAt: cached.fetchedAt,
          retryAt: now + request.retryAfterMs,
          ...cached.pool === undefined ? {} : { pool: cached.pool },
        })
      } catch {
        // The failure path's own write can fail on the same unreadable home;
        // the router then simply retries on the next cadence check.
      }
      return false
    }
  }

  /**
   * The pool in effect: the newer of the bundled and cached documents, minus
   * the user's exclusions, with their preferred models moved to the front.
   * @returns the ordered pool every selection reads.
   */
  async load(): Promise<PoolDocument> {
    const [cached, bundledPool, user] = await Promise.all([this.cache(), readBundled(), this.userConfig()])
    const base = cached.pool !== undefined && cached.pool.generated > bundledPool.generated ? cached.pool : bundledPool
    let entries: readonly PoolEntry[] = base.pool
    if (user.pool !== undefined) {
      try {
        entries = parsePool({ version: 1, pool: user.pool, models: user.models }).pool
      } catch {
        // A malformed replacement pool narrows nothing; the validated base stands.
      }
    }
    const excluded = (model: string): boolean => user.exclude.some(prefix =>
      model === prefix || model.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
    const kept = entries.filter(entry => !excluded(entry.model))
    if (user.prefer.length === 0) return { ...base, pool: kept }
    // Preference reorders keys the pool already admitted; a key the pool does
    // not carry buys nothing, so a typo cannot become a route.
    const preferred = user.prefer
      .map(model => kept.find(entry => entry.model === model))
      .filter((entry): entry is PoolEntry => entry !== undefined)
    return { ...base, pool: [...preferred, ...kept.filter(entry => !user.prefer.includes(entry.model))] }
  }

  async #writeCache(cache: PoolCache): Promise<void> {
    await writeFileAtomic(join(this.#directory, 'pool-cache.json'), JSON.stringify(cache), { mode: 0o600 })
  }
}
