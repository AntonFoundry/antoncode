/**
 * Cooldown state shared by every session that routes through the pool.
 *
 * The state file is a cache of what recently failed, not authority: a corrupt
 * or unreadable file costs a few retries, never a route. Writers serialise
 * through a sibling lock and commit with an atomic rename, so a concurrent
 * harness process cannot resurrect a state another one just replaced.
 *
 * @module @deepseek-ai/dsh-llm-vazhi/state
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { classify, parseRetryAfter, SHARED_KINDS, splitModelKey } from './providers.ts'

const MINUTE = 60_000
const SECOND = 1_000

/** One cooled-down model or upstream. */
export interface CooldownEntry {
  /** Epoch milliseconds at which the cooldown ends. */
  readonly until: number
  /** Consecutive failures that produced this cooldown. */
  readonly failures: number
  /** Classification and the provider text that caused it, truncated for storage. */
  readonly reason: string
  /** Epoch milliseconds of the last failure that wrote this entry. */
  readonly at: number
}

/** The last model that hit a shared limit on one upstream. */
export interface SharedLimitMark {
  /** Epoch milliseconds of the failure. */
  readonly at: number
  /** Model key that reported it. */
  readonly model: string
}

/** Everything the router remembers between requests. */
export interface RouterState {
  /** Per-model cooldowns, keyed by `provider/model`. */
  models: Record<string, CooldownEntry>
  /** Per-upstream cooldowns, keyed by provider. */
  providers: Record<string, CooldownEntry>
  /** Per-upstream shared-rate-limit marks. */
  lastLimit: Record<string, SharedLimitMark>
  /** Slow starters: model key to epoch milliseconds at which the mark expires. */
  slow: Record<string, number>
}

/**
 * A fresh, empty state.
 * @returns state with no cooldowns, shared-limit marks, or slow marks.
 */
export function emptyState(): RouterState {
  return { models: {}, providers: {}, lastLimit: {}, slow: {} }
}

/** The shortest cooldown a provider-stated delay may produce. */
const MINIMUM_STATED_COOLDOWN_MS = 5 * SECOND

/** Two shared-limit reports within this window cool the whole upstream. */
const SHARED_LIMIT_WINDOW_MS = 2 * MINUTE

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Read one cooldown entry, or undefined when any field is unusable. */
function readCooldown(value: unknown): CooldownEntry | undefined {
  if (!isRecord(value)) return undefined
  if (!finiteNumber(value.until) || !finiteNumber(value.failures) || !finiteNumber(value.at)) return undefined
  if (typeof value.reason !== 'string') return undefined
  return { until: value.until, failures: value.failures, reason: value.reason, at: value.at }
}

/** Keep only the entries whose every field a writer would have produced. */
function sanitize(raw: unknown): RouterState {
  const state = emptyState()
  if (!isRecord(raw)) return state
  for (const name of ['models', 'providers'] as const) {
    const source = raw[name]
    if (!isRecord(source)) continue
    for (const [key, value] of Object.entries(source)) {
      const entry = readCooldown(value)
      if (entry !== undefined) state[name][key] = entry
    }
  }
  if (isRecord(raw.lastLimit)) {
    for (const [key, value] of Object.entries(raw.lastLimit)) {
      if (!isRecord(value) || !finiteNumber(value.at) || typeof value.model !== 'string') continue
      state.lastLimit[key] = { at: value.at, model: value.model }
    }
  }
  if (isRecord(raw.slow)) {
    for (const [key, value] of Object.entries(raw.slow)) {
      if (finiteNumber(value)) state.slow[key] = value
    }
  }
  return state
}

/**
 * The on-disk cooldown store under one directory (`state.json`).
 *
 * Every mutation is best-effort: the cooldown cache never fails a request, so
 * a lock timeout or a write failure reports through `onWarning` and the
 * attempt proceeds as if the write had landed.
 */
export class CooldownStore {
  readonly #file: string
  readonly #directory: string
  readonly #onWarning: (error: unknown) => void

  /**
   * @param directory - directory holding `state.json`.
   * @param onWarning - receives a failed read-modify-write; the cache is advisory.
   */
  constructor(directory: string, onWarning: (error: unknown) => void = () => {}) {
    this.#directory = directory
    this.#file = join(directory, 'state.json')
    this.#onWarning = onWarning
  }

  /**
   * The current state; a missing or malformed file reads as empty.
   * @returns the sanitized state, with unusable entries dropped.
   */
  async load(): Promise<RouterState> {
    try {
      return sanitize(JSON.parse(await readFile(this.#file, 'utf8')) as unknown)
    } catch {
      // Absence, permissions, and malformed JSON all mean "nothing is cooling down".
      return emptyState()
    }
  }

  /**
   * Run one read-modify-write under the cross-process writer lock.
   * @param change - mutates the freshly loaded state in place.
   */
  async update(change: (state: RouterState) => void): Promise<void> {
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 })
      await withFileLock(this.#file, async () => {
        const state = await this.load()
        change(state)
        await writeFileAtomic(this.#file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      })
    } catch (error) {
      this.#onWarning(error)
    }
  }
}

/** Keep whichever entry ends later, recording this attempt's outcome either way. */
function extend(
  entries: Record<string, CooldownEntry>,
  key: string,
  now: number,
  until: number,
  failures: number,
  reason: string,
): void {
  const existing = entries[key]
  if (existing !== undefined && existing.until > until) {
    entries[key] = { ...existing, failures, at: now }
    return
  }
  entries[key] = { until, failures, reason, at: now }
}

/**
 * Cool a model down after a failed attempt.
 * @param state - mutable state to update.
 * @param key - failed `provider/model`.
 * @param text - provider or transport error text to classify.
 * @param now - epoch milliseconds of the failure.
 * @param sharedLimits - upstreams whose rate limits are shared across their models.
 * @returns the cooldown applied, in milliseconds.
 */
export function penalize(
  state: RouterState,
  key: string,
  text: string,
  now: number,
  sharedLimits: readonly string[] = [],
): number {
  const [provider] = splitModelKey(key)
  const { kind, baseMs, maxMs } = classify(text, provider)
  const failures = (state.models[key]?.failures ?? 0) + 1
  const stated = parseRetryAfter(text)
  const ms = stated === undefined
    ? Math.min(baseMs * 2 ** (failures - 1), maxMs)
    : Math.max(stated, MINIMUM_STATED_COOLDOWN_MS)
  const reason = `${kind}: ${text.split(/\s+/).filter(Boolean).join(' ').slice(0, 160)}`
  extend(state.models, key, now, now + ms, failures, reason)
  if (kind === 'auth') extend(state.providers, provider, now, now + ms, 1, reason)
  if (sharedLimits.includes(provider) && SHARED_KINDS.has(kind)) {
    const last = state.lastLimit[provider]
    if (last !== undefined && last.model !== key && now - last.at < SHARED_LIMIT_WINDOW_MS) {
      extend(state.providers, provider, now, now + ms, 1, `provider-wide ${reason}`)
    }
    state.lastLimit[provider] = { at: now, model: key }
  }
  return ms
}

/**
 * Clear whatever cooled a model or its upstream before the successful request
 * started, leaving newer failures untouched.
 * @param state - mutable state to update.
 * @param key - the model that answered.
 * @param startedAt - epoch milliseconds at which the successful attempt began.
 */
export function recover(state: RouterState, key: string, startedAt: number): void {
  const [provider] = splitModelKey(key)
  if ((state.models[key]?.at ?? 0) <= startedAt) Reflect.deleteProperty(state.models, key)
  if ((state.providers[provider]?.at ?? 0) <= startedAt) Reflect.deleteProperty(state.providers, provider)
  if ((state.lastLimit[provider]?.at ?? 0) <= startedAt) Reflect.deleteProperty(state.lastLimit, provider)
}

/**
 * When one model becomes usable again, considering its upstream's cooldown.
 * @param state - current state.
 * @param model - `provider/model` to inspect.
 * @returns epoch milliseconds; 0 when nothing holds it back.
 */
export function readyAt(state: RouterState, model: string): number {
  const [provider] = splitModelKey(model)
  return Math.max(state.models[model]?.until ?? 0, state.providers[provider]?.until ?? 0)
}

/**
 * Mark a slow starter, or clear the mark when it answered quickly.
 * @param state - mutable state to update.
 * @param key - the model that answered.
 * @param firstTokenMs - time from request start to the first token.
 * @param now - epoch milliseconds of the response.
 * @param slowStartMs - threshold above which a start counts as slow.
 * @param slowForMs - how long the slow mark keeps the model behind the rest.
 */
export function noteStart(
  state: RouterState,
  key: string,
  firstTokenMs: number,
  now: number,
  slowStartMs: number,
  slowForMs: number,
): void {
  for (const [stale, until] of Object.entries(state.slow)) {
    if (until <= now) Reflect.deleteProperty(state.slow, stale)
  }
  if (firstTokenMs > slowStartMs) {
    state.slow[key] = Math.max(state.slow[key] ?? 0, now + slowForMs)
  }
}

/** The pool pick for one attempt. */
export interface PoolPick {
  /** The chosen model, or undefined when every ready model is unavailable. */
  readonly model?: string
  /** When nothing is ready, how long until the earliest one frees up. */
  readonly waitMs: number
}

/**
 * Pick the next model in pool order, skipping cooldowns, the attempt that just
 * failed, and (behind everything else) slow starters.
 * @param entries - pool models in preference order.
 * @param state - current cooldown state.
 * @param now - epoch milliseconds.
 * @param failed - model key whose attempt just failed, if any.
 * @returns the pick, or the wait until the earliest cooled-down model returns.
 */
export function choose(
  entries: readonly string[],
  state: RouterState,
  now: number,
  failed?: string,
): PoolPick {
  const ready = entries.filter(model => readyAt(state, model) <= now)
  const excludingFailed = failed === undefined ? ready : ready.filter(model => model !== failed)
  const usable = failed !== undefined && excludingFailed.length === 0 ? ready : excludingFailed
  const fast = usable.filter(model => (state.slow[model] ?? 0) <= now)
  const slow = usable.filter(model => (state.slow[model] ?? 0) > now)
  const ordered = [...fast, ...slow]
  const first = ordered[0]
  if (first !== undefined) return { model: first, waitMs: 0 }
  if (entries.length === 0) return { waitMs: 0 }
  const next = entries.reduce((earliest, model) =>
    readyAt(state, model) < readyAt(state, earliest) ? model : earliest)
  return { waitMs: Math.max(0, readyAt(state, next) - now) }
}
