/**
 * Register the `vazhi` free-model pool route on `ctx.llm`.
 *
 * The provider table, free-model admission rules, failure classification,
 * cooldowns, and the bundled pool are ported from vazhi
 * (https://github.com/itsgg/vazhi, MIT, (c) itsgg). Upstream base URLs stay in
 * {@link PROVIDERS}; a downloaded or user-supplied pool can only name a model
 * that its own upstream's rule admits, so pool content cannot redirect a
 * prompt or admit a paid model.
 *
 * `vazhi/auto` lets the router choose in ranked pool order; `vazhi/<upstream>/
 * <model>` pins one entry. A pinned model that fails surfaces its own provider
 * error instead of falling through, because the user asked for that model.
 *
 * State lives under `$DSH_HOME/vazhi/`: `state.json` (cooldowns),
 * `pool-cache.json` (download plus retry state), and `config.json` (the
 * user's `prefer`/`exclude`/`pool` narrowing).
 *
 * @module @deepseek-ai/dsh-llm-vazhi
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  assertUsableApiKey,
  resolveRetryPolicy,
  RetryPolicySchema,
  type AdapterRegistrationHandle,
  type RetryPolicyConfig,
} from '@deepseek-ai/dsh-llm'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '@deepseek-ai/dsh-llm-openai'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { VazhiAdapter, type VazhiResolvedOptions, type VazhiRouter } from './adapter.ts'
import { PoolStore } from './pool.ts'
import {
  credentialRefOf,
  endpointFor,
  PROVIDERS,
  splitModelKey,
  type VazhiEndpoint,
} from './providers.ts'
import { CooldownStore, penalize, noteStart, recover } from './state.ts'

export { VazhiAdapter, AUTO_MODEL, AUTO_MODEL_NAME } from './adapter.ts'
export type { VazhiAdapterOptions, VazhiResolvedOptions, VazhiRouter } from './adapter.ts'
export { PoolStore, parsePool } from './pool.ts'
export type { PoolDocument, PoolEntry, PoolModelMeta, UserPoolConfig } from './pool.ts'
export {
  allowedInPool,
  classify,
  credentialRefOf,
  endpointFor,
  formatDuration,
  parseRetryAfter,
  PROVIDERS,
  splitModelKey,
  type FailureClass,
  type UpstreamSpec,
  type VazhiEndpoint,
} from './providers.ts'
export { choose, CooldownStore, emptyState, readyAt } from './state.ts'
export type { CooldownEntry, PoolPick, RouterState } from './state.ts'

export const name = 'llm-vazhi'
export const inject = ['llm']

const NS = settingsNamespace('llm-vazhi')

/** The single provider route this plugin owns. */
export const PROVIDER = 'vazhi'

/** Selector label used when the section names none. */
export const DEFAULT_DISPLAY_NAME = 'Vazhi'

/** The published pool vazhi refreshes; a pinned commit would freeze free-model coverage. */
export const DEFAULT_POOL_URL = 'https://raw.githubusercontent.com/itsgg/vazhi/main/pool.json'

/** Pool download cadence. */
export const DEFAULT_POOL_REFRESH_MS = 12 * 3_600_000

/** How long a failed download waits before retrying. */
export const DEFAULT_POOL_RETRY_AFTER_MS = 3_600_000

/** Bound on one pool download. */
export const DEFAULT_POOL_TIMEOUT_MS = 10_000

/** Upstream attempts one request may make before reporting exhaustion. */
export const DEFAULT_MAX_ATTEMPTS = 6

/** First-token time above which an attempt counts as a slow starter. */
export const DEFAULT_SLOW_START_MS = 15_000

/** How long a slow mark keeps a model behind the rest of the pool. */
export const DEFAULT_SLOW_FOR_MS = 600_000

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-vazhi` settings-section shape. Every field is optional.
 */
export interface Config {
  /** Selector label for this route. */
  displayName?: string
  /** Directory holding cooldown state, the pool cache, and the user's narrowing document. */
  directory?: string
  /** Pool document URL, refreshed on `poolRefreshMs`. */
  poolURL?: string
  /** Pool download cadence in milliseconds. */
  poolRefreshMs?: number
  /** Wait after a failed pool download. */
  poolRetryAfterMs?: number
  /** Bound on one pool download. */
  poolTimeoutMs?: number
  /** Upstream attempts one request may make. */
  maxAttempts?: number
  /** First-token time above which an attempt counts as a slow starter. */
  slowStartMs?: number
  /** How long a slow mark keeps a model behind the rest of the pool. */
  slowForMs?: number
  /** Default per-request output cap; explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the pool carries no exact value. */
  defaultContextWindow?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

export const Config: z<Config> = z.object({
  displayName: z.string().default(DEFAULT_DISPLAY_NAME),
  directory: z.string(),
  poolURL: z.string().default(DEFAULT_POOL_URL),
  poolRefreshMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_POOL_REFRESH_MS),
  poolRetryAfterMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_POOL_RETRY_AFTER_MS),
  poolTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_POOL_TIMEOUT_MS),
  maxAttempts: z.number().step(1).min(1).max(100).default(DEFAULT_MAX_ATTEMPTS),
  slowStartMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_SLOW_START_MS),
  slowForMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_SLOW_FOR_MS),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** One resolution's complete pool and request facts. */
export interface ResolvedVazhiOptions extends VazhiResolvedOptions {
  /** Pool document URL. */
  readonly poolURL: string
  /** Pool download cadence in milliseconds. */
  readonly poolRefreshMs: number
  /** Wait after a failed pool download. */
  readonly poolRetryAfterMs: number
  /** Bound on one pool download. */
  readonly poolTimeoutMs: number
}

function positiveInteger(value: number, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`llm-vazhi: ${field} must be a positive integer no greater than ${maximum}`)
  }
  return value
}

/**
 * The one explicit resolve step from raw config to validated pool and request
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here.
 * @param config - raw plugin config or a resolved settings snapshot.
 * @returns validated connection, pool, and policy facts.
 */
export function resolveAdapterOptions(config: Config): ResolvedVazhiOptions {
  const displayName = config.displayName ?? DEFAULT_DISPLAY_NAME
  if (displayName.length === 0) throw new Error('llm-vazhi: displayName must be non-empty')
  const directory = config.directory ?? dshHomePath('vazhi')
  if (directory.length === 0) throw new Error('llm-vazhi: directory must be non-empty')
  const poolURL = config.poolURL ?? DEFAULT_POOL_URL
  if (poolURL.length === 0) throw new Error('llm-vazhi: poolURL must be non-empty')
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('llm-vazhi: maxTokens must be a positive safe integer')
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('llm-vazhi: defaultContextWindow must be a positive integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-vazhi: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return {
    directory,
    displayName,
    poolURL,
    poolRefreshMs: positiveInteger(config.poolRefreshMs ?? DEFAULT_POOL_REFRESH_MS, 'poolRefreshMs', MAX_TIMER_DELAY_MS),
    poolRetryAfterMs: positiveInteger(config.poolRetryAfterMs ?? DEFAULT_POOL_RETRY_AFTER_MS, 'poolRetryAfterMs', MAX_TIMER_DELAY_MS),
    poolTimeoutMs: positiveInteger(config.poolTimeoutMs ?? DEFAULT_POOL_TIMEOUT_MS, 'poolTimeoutMs', MAX_TIMER_DELAY_MS),
    maxAttempts: positiveInteger(config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts', 100),
    slowStartMs: positiveInteger(config.slowStartMs ?? DEFAULT_SLOW_START_MS, 'slowStartMs', MAX_TIMER_DELAY_MS),
    slowForMs: positiveInteger(config.slowForMs ?? DEFAULT_SLOW_FOR_MS, 'slowForMs', MAX_TIMER_DELAY_MS),
    maxTokens,
    defaultContextWindow,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-vazhi: retryPolicy'),
  }
}

/**
 * Resolve one upstream's key: the managed credential store first, then the
 * launching environment.
 * @param ctx - plugin context carrying the optional credentials seam.
 * @param ref - the credential reference to resolve.
 * @returns the usable key, or `undefined` when no key exists anywhere.
 */
async function resolveCredential(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    return hit === undefined ? undefined : assertUsableApiKey(hit.value, 'llm-vazhi', ref)
  }
  const ambient = launchEnvironmentOf(ctx).get(ref)
  if (ambient === undefined || ambient.value.length === 0) return undefined
  return assertUsableApiKey(ambient.value, 'llm-vazhi', ref)
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let resolved = resolveAdapterOptions(current())
  const warn = (error: unknown): void => {
    ctx.logger.warn('llm-vazhi: cooldown bookkeeping failed; the attempt proceeds as if it had landed')
    ctx.logger.warn(error)
  }
  // One store per directory: a settings change to `directory` starts from that
  // directory's own files instead of the mount-time one.
  const pools = new Map<string, PoolStore>()
  const cooldowns = new Map<string, CooldownStore>()
  const poolStore = (directory: string): PoolStore => {
    const existing = pools.get(directory)
    if (existing !== undefined) return existing
    const created = new PoolStore(directory)
    pools.set(directory, created)
    return created
  }
  const cooldownStore = (directory: string): CooldownStore => {
    const existing = cooldowns.get(directory)
    if (existing !== undefined) return existing
    const created = new CooldownStore(directory, warn)
    cooldowns.set(directory, created)
    return created
  }

  const endpointOf = async (model: string): Promise<VazhiEndpoint | undefined> => {
    const [provider] = splitModelKey(model)
    const ref = credentialRefOf(provider)
    if (ref === undefined) return endpointFor(model, undefined)
    let key: string | undefined
    try {
      key = await resolveCredential(ctx, credentialRef(ref))
    } catch (error) {
      // A stored key no HTTP header can carry is unusable, exactly like an
      // absent one; the model is skipped and a pinned selection names the ref.
      ctx.logger.warn(`llm-vazhi: ignoring the unusable key in ${ref}`)
      ctx.logger.warn(error)
      return undefined
    }
    return endpointFor(model, key)
  }

  const router: VazhiRouter = {
    loadPool: () => poolStore(resolved.directory).load(),
    loadState: () => cooldownStore(resolved.directory).load(),
    availableUpstreams: async () => {
      const available = new Set<string>()
      for (const provider of Object.keys(PROVIDERS)) {
        const ref = credentialRefOf(provider)
        if (ref === undefined) {
          // No credential reference is what makes an upstream anonymous.
          available.add(provider)
          continue
        }
        try {
          if (await resolveCredential(ctx, credentialRef(ref)) !== undefined) available.add(provider)
        } catch {
          // An unusable stored key buys no availability; the request-time path
          // reports it when that model is selected.
          continue
        }
      }
      return available
    },
    endpointOf,
    penalize: async (model, text) => {
      const directory = resolved.directory
      const sharedLimits = (await poolStore(directory).load()).sharedLimits
      await cooldownStore(directory).update((state) => {
        penalize(state, model, text, Date.now(), sharedLimits)
      })
    },
    recover: async (model, startedAt) => {
      const directory = resolved.directory
      await cooldownStore(directory).update((state) => {
        recover(state, model, startedAt)
      })
    },
    noteStart: async (model, firstTokenMs) => {
      const directory = resolved.directory
      const options = resolved
      await cooldownStore(directory).update((state) => {
        noteStart(state, model, firstTokenMs, Date.now(), options.slowStartMs, options.slowForMs)
      })
    },
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  const adapter = new VazhiAdapter({ options: () => resolved, router, resolveUserId })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: resolved.displayName, settingsNs: NS, settingsPath: [] },
  ])
  const registration: AdapterRegistrationHandle = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = resolved.retryPolicy

  const refreshPool = async (force: boolean): Promise<void> => {
    const options = resolved
    const updated = await poolStore(options.directory).refresh({
      url: options.poolURL,
      refreshMs: options.poolRefreshMs,
      retryAfterMs: options.poolRetryAfterMs,
      timeoutMs: options.poolTimeoutMs,
      force,
    })
    if (updated) ctx.logger.info('llm-vazhi: replaced the free-model pool from the published document')
  }

  // Warm the pool at mount and on cadence; a failed download keeps serving the
  // bundled or cached document, so an upstream outage never empties the picker.
  void refreshPool(false)
  ctx.effect(() => {
    // The mount-time cadence: a settings change to `poolRefreshMs` takes effect
    // on the next restart, while the URL and timeouts are read per refresh.
    const timer = setInterval(() => {
      void refreshPool(false)
    }, resolved.poolRefreshMs)
    return () => {
      clearInterval(timer)
    }
  })

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      const previous = resolved
      try {
        resolved = resolveAdapterOptions(current())
      } catch (error) {
        ctx.logger.error('llm-vazhi: keeping the last good configuration after an invalid settings section')
        ctx.logger.error(error)
        resolved = previous
      }
      if (!deepEqualJson(resolved.retryPolicy, registeredPolicy)) {
        // The registry captured the retry policy at registration; re-reading
        // it in one synchronous section leaves no request observing a gap.
        registration.replace([PROVIDER])
        registeredPolicy = resolved.retryPolicy
      }
    },
  })
}
