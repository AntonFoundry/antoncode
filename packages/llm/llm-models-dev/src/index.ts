/**
 * Register a {@link ModelsDevAdapter} serving the free tiers of models.dev
 * catalog providers — the native port of the free-model pickers in OpenCode
 * and OpenRouter. Discovery reads `https://models.dev/api.json` (the same
 * catalog OpenCode itself bundles) and lists each route's free chat models,
 * using OpenCode's input-cost rule for Zen and explicit zero input/output
 * costs for other gateways;
 * streaming rides each provider's own OpenAI-compatible gateway through the
 * inherited llm-openai transport. OpenCode Zen uses `OPENCODE_API_KEY` with
 * bearer auth (or the public anonymous key) and OpenCode-compatible request
 * identity headers. Per-route `headers` can add gateway-specific values.
 *
 * The `openrouter-free` route ships live (its free `:free` models still require
 * an API key — requests fail `MISSING_CREDENTIAL` until one is stored). A
 * `llm-models-dev:` settings section overrides endpoints, key references, or
 * the shipped route set without a restart.
 *
 * Discovery freshness is push-based: the mount fetches every configured
 * route's tier once up front and re-fetches on `catalogRefreshMs` (eight
 * hours by default) through a fiber-owned interval, so a restart always converges
 * on the newest models.dev document without waiting for a picker query; a
 * failed refresh keeps serving the last good snapshot.
 *
 * @module @deepseek-ai/dsh-llm-models-dev
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: merges the loader's `Fiber.entry`, which names this entry's
// settings namespace.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from '@deepseek-ai/dsh-llm-openai'
import type { OpenAIConnectionOptions } from '@deepseek-ai/dsh-llm-openai'
import type { ModelsDevConnectionOptions } from './adapter.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { ModelsDevCatalog } from './catalog.ts'
import { ModelsDevAdapter } from './adapter.ts'

export { ModelsDevAdapter } from './adapter.ts'
export type { ModelsDevAdapterOptions, ModelsDevConnectionOptions } from './adapter.ts'
export { ModelsDevCatalog, parseFreeModels, parseModelProtocols } from './catalog.ts'
export type { CatalogModel } from './catalog.ts'

export const name = 'llm-models-dev'
export const inject = ['llm']


/** The models.dev root every catalog fetch resolves against. */
export const DEFAULT_CATALOG_URL = 'https://models.dev'
/**
 * Eight hours: the catalog document republishes continuously, and a query
 * against a snapshot older than this cadence refetches on read, so staleness
 * never outlives the interval by more than one picker query.
 */
export const DEFAULT_CATALOG_REFRESH_MS = 28_800_000
/** The literal anonymous key OpenCode Zen accepts for its free tier. */
const ZEN_ANONYMOUS_KEY = 'public'
/** Session-id fallback for a request that carries no conversation session. */
const fallbackSessionId = randomUUID()

/** One shipped route with the external facts that never vary per deployment. */
interface DeclaredRoute {
  /** Route id: the provider registry key and the `providers` dict default. */
  readonly provider: string
  readonly displayName: string
  /** models.dev provider id whose free tier the route serves. */
  readonly catalogProvider: string
  /** Gateway base; `/chat/completions` is appended. */
  readonly baseURL: string
  /** Credential reference resolved per request when no profile names one. */
  readonly apiKeyEnv: string
  /** Whether the gateway accepts anonymous free-tier requests. */
  readonly anonymous: boolean
}

/**
 * The routes this plugin declares in the configurable-provider directory.
 * The facts are external specs read from each provider's published gateway
 * and catalog entry, not deployment tunables.
 */
const DECLARED: readonly DeclaredRoute[] = [
  {
    provider: 'openrouter-free',
    displayName: 'OpenRouter Free',
    catalogProvider: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_FREE_API_KEY',
    anonymous: false,
  },
]

function declared(provider: string): DeclaredRoute | undefined {
  return DECLARED.find(entry => entry.provider === provider)
}

/**
 * Per-route profile overriding one declared route's facts; the `providers`
 * dict key IS the route id. A profile for an undeclared route must name
 * {@link FreeRouteProfile.catalogProvider}; the route id minus a trailing
 * `-free` is otherwise the catalog identity.
 */
export interface ModelDevProviderProfile {
  /** models.dev provider id whose free tier this route serves. */
  catalogProvider?: string
  /** Credential reference (environment-variable name) resolved per request. */
  apiKeyEnv?: string
  /** Gateway endpoint base; `/chat/completions` is appended. */
  baseURL?: string
  /** Selector label for this route. */
  displayName?: string
  /** Accept anonymous free-tier requests when no key resolves (gateway-dependent). */
  anonymous?: boolean
  /** Additional provider-specific HTTP headers; transport-owned headers win collisions. */
  headers?: Record<string, string>
}

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-models-dev` settings-section shape.
 */
export interface Config {
  /** Catalog root fetched as `<catalogURL>/api.json`; defaults to models.dev. */
  catalogURL?: string
  /** Re-fetch cadence: the mount fetches eagerly, then this interval re-fetches in the background. */
  catalogRefreshMs?: number
  /** Default per-request output cap; explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the catalog has no exact value. */
  defaultContextWindow?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
  /**
   * Provider routes keyed by route id. An empty dict unregisters every route:
   * the dormant posture mirrors `llm-openai`.
   */
  providers?: Record<string, ModelDevProviderProfile>
}

const profileSchema: z<ModelDevProviderProfile> = z.object({
  catalogProvider: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
  displayName: z.string(),
  anonymous: z.boolean(),
  headers: z.dict(z.string()),
})

export const Config: z<Config> = z.object({
  catalogURL: z.string().default(DEFAULT_CATALOG_URL),
  catalogRefreshMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CATALOG_REFRESH_MS),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  providers: z.dict(profileSchema).default(Object.fromEntries(DECLARED.map(route => [route.provider, {}]))),
})

/** One resolution's complete request facts (the adapter's connection options). */
export type ResolvedModelsDevOptions = ModelsDevConnectionOptions

/**
 * Build the Zen client headers for one request, mirroring the session,
 * request, and client headers in OpenCode's upstream request module.
 * Project identity is omitted because the Harness does not expose
 * OpenCode's project id to the model adapter.
 * @param provider - the route the request targets; non-`opencode*` routes get no headers.
 * @param sessionId - the conversation session id, or `undefined` for the process fallback.
 * @param requestId - the latest user message id, or `undefined` for a generated fallback.
 * @returns the route-scoped headers for this one request.
 */
export function resolveZenHeaders(provider: string, sessionId: string | undefined, requestId?: string): Record<string, string> {
  if (!provider.startsWith('opencode')) return {}
  const session = sessionId ?? fallbackSessionId
  const request = requestId ?? `msg_${randomUUID()}`
  const client = process.env.OPENCODE_CLIENT ?? 'cli'
  return {
    'x-opencode-session': session,
    'x-opencode-request': request,
    'x-opencode-client': client,
    'x-opencode-session-id': session,
    'user-agent': 'opencode/harness',
  }
}

/**
 * The one explicit resolve step from raw config to one route's validated
 * connection facts. Called at load (fail loud) and per settings snapshot.
 * @param config - raw plugin configuration.
 * @param provider - provider route to resolve.
 * @returns validated connection facts with explicit defaults.
 * @throws Error when configuration values cannot serve the route.
 */
export function resolveAdapterOptions(config: Config, provider: string): ResolvedModelsDevOptions {
  const catalogRefreshMs = config.catalogRefreshMs ?? DEFAULT_CATALOG_REFRESH_MS
  if (!Number.isInteger(catalogRefreshMs) || catalogRefreshMs <= 0 || catalogRefreshMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-models-dev: catalogRefreshMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('llm-models-dev: maxTokens must be a positive safe integer')
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('llm-models-dev: defaultContextWindow must be a positive integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-models-dev: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }

  const route = config.providers?.[provider]
  const meta = declared(provider)
  const catalogProvider = route?.catalogProvider ?? meta?.catalogProvider
    ?? (provider.endsWith('-free') ? provider.slice(0, -'-free'.length) : undefined)
  if (catalogProvider === undefined || catalogProvider.length === 0) {
    throw new Error(`llm-models-dev: provider "${provider}" needs a catalogProvider (the id cannot be derived)`)
  }
  for (const [field, value] of Object.entries({
    catalogProvider: route?.catalogProvider,
    apiKeyEnv: route?.apiKeyEnv,
    baseURL: route?.baseURL,
    displayName: route?.displayName,
  })) {
    if (value !== undefined && value.length === 0) throw new Error(`llm-models-dev: provider "${provider}" has an empty ${field}`)
  }
  const baseURL = route?.baseURL ?? meta?.baseURL
  if (baseURL === undefined || baseURL.length === 0) {
    throw new Error(`llm-models-dev: provider "${provider}" needs a baseURL (no shipped default exists for the route)`)
  }
  return {
    apiKeyEnv: credentialRef(route?.apiKeyEnv ?? meta?.apiKeyEnv ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`),
    ...(route?.headers === undefined ? {} : { headers: { ...route.headers } }),
    baseURL,
    displayName: route?.displayName ?? meta?.displayName ?? provider,
    defaults: catalogProvider === 'openrouter' ? { reasoningDialect: 'openrouter' } : {},
    maxTokens,
    defaultContextWindow,
    models: [],
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-models-dev: retryPolicy'),
    catalogProvider,
  }
}

/**
 * The effective anonymous posture of one route after profile layering.
 * @param config - raw configuration carrying route overrides.
 * @param provider - route whose anonymous-access setting is selected.
 * @returns the route override, shipped default, or false for an undeclared route.
 */
export function resolveAnonymous(config: Config, provider: string): boolean {
  return config.providers?.[provider]?.anonymous ?? declared(provider)?.anonymous ?? false
}

/**
 * Reject a section this adapter could not serve, where it is written.
 * @param config - raw configuration whose declared routes must resolve.
 * @throws Error when a route or shared setting is invalid.
 */
export function assertServiceable(config: Config): void {
  const routes = Object.keys(config.providers ?? {})
  if (routes.length === 0) {
    // No profile to judge: resolve a declared route profilelessly so the
    // section's own fields still face their bounds.
    // A declared id literal: the array index itself carries no narrowing.
    resolveAdapterOptions(config, 'openrouter-free')
    return
  }
  for (const provider of routes) resolveAdapterOptions(config, provider)
}

export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false, editableConfig: true }, ctx.fiber)) })
  // Settings are Config-derived: an edit reloads the entry and re-applies the
  // plugin, so resolution is per-route for one application.
  const settingsNs = ctx.fiber.entry?.options.id ?? name
  const cache = new Map<string, ResolvedModelsDevOptions>()
  const options = (provider: string): ResolvedModelsDevOptions => {
    const cached = cache.get(provider)
    if (cached !== undefined) return cached
    const next = resolveAdapterOptions(config, provider)
    cache.set(provider, next)
    return next
  }

  assertServiceable(config)

  const resolveApiKey = async (provider: string, connection: OpenAIConnectionOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    if (ref === undefined) {
      throw new LlmError(`llm-models-dev: provider route "${provider}" resolved without a credential reference`, 'MISSING_CREDENTIAL')
    }
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-models-dev', ref)
    } else {
      const ambient = process.env[ref]
      if (ambient !== undefined && ambient.length > 0) {
        return assertUsableApiKey(ambient, 'llm-models-dev', ref)
      }
    }
    if (resolveAnonymous(config, provider)) return ZEN_ANONYMOUS_KEY
    throw new LlmError(
      `llm-models-dev: no API key for provider route "${provider}"; store ${connection.apiKeyEnv}`
      + ' through the credentials service (the web Models page writes it), or export'
      + ` ${connection.apiKeyEnv} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  const onCatalogError = (error: unknown): void => {
    ctx.logger.warn('llm-models-dev: serving the last good catalog snapshot after a failed refresh')
    ctx.logger.warn(error)
  }
  const catalog = new ModelsDevCatalog(
    config.catalogURL ?? DEFAULT_CATALOG_URL,
    config.catalogRefreshMs ?? DEFAULT_CATALOG_REFRESH_MS,
  )
  const adapter = new ModelsDevAdapter({
    options,
    resolveApiKey,
    resolveUserId,
    catalog,
    // The Zen free tier is client-gated: without a session header the
    // gateway answers MissingSessionID regardless of model or key (see
    // {@link resolveZenHeaders}). Only `opencode*` routes carry these: other
    // family routes (e.g. `openrouter-free`) must not see them. The OpenCode
    // User-Agent is prefixed to mandatory Harness attribution by the transport.
    extraHeaders: (provider, _connection, sessionId, requestId) => resolveZenHeaders(provider, sessionId, requestId),
    // The catalog declares each model's wire protocol (`provider.npm`):
    // Muse Spark on Zen serves only the OpenAI Responses protocol, and
    // chat-completions for it is a hard 500 — free or paid id alike. The
    // protocol map covers every catalog model, not just the free picker set,
    // so a paid id like `muse-spark-1.3` routes to `/responses` too.
    modelProtocol: (provider, model) => catalog
      .peekProtocol(options(provider).catalogProvider, model) === 'responses'
      ? 'responses'
      : 'chat-completions',
    onCatalogError,
  })

  ctx.llm.registerConfigurableProviders(DECLARED.map(({ provider, displayName }) => ({
    provider,
    displayName,
    settingsNs,
    settingsPath: ['providers', provider],
  })))

  // Resolving every configured route up front keeps a misconfigured one loud
  // at load rather than at the first request it would serve.
  const routes = Object.keys(config.providers ?? {})
  for (const provider of routes) options(provider)
  if (routes.length > 0) ctx.llm.registerAdapter(routes, adapter)

  /**
   * Fetch every configured route's tier now, deduplicating routes that share
   * one catalog identity. Called once at mount and on every interval tick: a
   * restart — and each subsequent interval at the default `catalogRefreshMs` —
   * converges on the newest models.dev document without waiting for a picker
   * query. Every route here has already passed `assertServiceable` (mount and
   * each validated settings generation), so resolution cannot throw; a failed
   * refresh reports through {@link onCatalogError} and keeps the previous
   * snapshot, and the next tick retries.
   */
  const refreshRoutes = (): void => {
    const providers = new Set(
      Object.keys(config.providers ?? {}).map(route => options(route).catalogProvider),
    )
    for (const provider of providers) void catalog.refresh(provider, onCatalogError)
  }
  refreshRoutes()
  ctx.effect(() => {
    const timer = setInterval(refreshRoutes, config.catalogRefreshMs ?? DEFAULT_CATALOG_REFRESH_MS)
    return () => { clearInterval(timer) }
  })

}
