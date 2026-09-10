/**
 * Register a {@link ModelsDevAdapter} serving the free tiers of models.dev
 * catalog providers — the native port of the free-model pickers in OpenCode
 * and OpenRouter. Discovery reads `https://models.dev/api.json` (the same
 * catalog OpenCode itself bundles) and lists each route's zero-cost chat
 * models, keeping deprecated entries exactly as OpenCode's picker does;
 * streaming rides each provider's own OpenAI-compatible gateway through the
 * inherited llm-openai transport, stamped with the client identity facts
 * OpenCode Zen's free tier requires (see {@link ZEN_CLIENT_USER_AGENT}).
 *
 * Two routes ship live: `opencode-free` (OpenCode Zen, anonymous access with
 * the gateway's literal `public` key, exactly as opencode itself falls back)
 * and `openrouter-free` (OpenRouter, whose free `:free` models still require
 * an API key — requests fail `MISSING_CREDENTIAL` until one is stored). A
 * `llm-models-dev:` settings section overrides endpoints, key references, or
 * the shipped route set without a restart.
 *
 * @module @deepseek-ai/dsh-llm-models-dev
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from '@deepseek-ai/dsh-llm-openai'
import type { OpenAIConnectionOptions } from '@deepseek-ai/dsh-llm-openai'
import type { ModelsDevConnectionOptions } from './adapter.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { ModelsDevCatalog } from './catalog.ts'
import { ModelsDevAdapter } from './adapter.ts'

export { ModelsDevAdapter } from './adapter.ts'
export type { ModelsDevAdapterOptions, ModelsDevConnectionOptions } from './adapter.ts'
export { ModelsDevCatalog, parseFreeModels } from './catalog.ts'
export type { CatalogModel } from './catalog.ts'

export const name = 'llm-models-dev'
export const inject = ['llm']

const NS = settingsNamespace('llm-models-dev')

/** The models.dev root every catalog fetch resolves against. */
export const DEFAULT_CATALOG_URL = 'https://models.dev'
/** One hour: models.dev refreshes its document at about this cadence. */
export const DEFAULT_CATALOG_REFRESH_MS = 3_600_000
/** The literal anonymous key OpenCode Zen accepts for its free tier. */
const ZEN_ANONYMOUS_KEY = 'public'
/**
 * The client identity OpenCode Zen's free tier demands: requests without an
 * `opencode/*` User-Agent and a session id fail `MissingSessionID` before the
 * model is ever consulted. This plugin is the port of OpenCode's own free
 * picker, so it presents the same client facts. The User-Agent value is an
 * external wire requirement of the gateway, not a deployment tunable.
 */
const ZEN_CLIENT_USER_AGENT = 'opencode/1.0'
/** Session-id fallback for a request that carries no conversation session. */
const fallbackSessionId = crypto.randomUUID()

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
    provider: 'opencode-free',
    displayName: 'OpenCode Free',
    catalogProvider: 'opencode',
    baseURL: 'https://opencode.ai/zen/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    anonymous: true,
  },
  {
    provider: 'openrouter-free',
    displayName: 'OpenRouter Free',
    catalogProvider: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
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
}

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-models-dev` settings-section shape.
 */
export interface Config {
  /** Catalog root fetched as `<catalogURL>/api.json`; defaults to models.dev. */
  catalogURL?: string
  /** How long one fetched snapshot serves before the next discovery refreshes it. */
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
 * The one explicit resolve step from raw config to one route's validated
 * connection facts. Called at load (fail loud) and per settings snapshot.
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
    baseURL,
    displayName: route?.displayName ?? meta?.displayName ?? provider,
    defaults: {},
    maxTokens,
    defaultContextWindow,
    models: [],
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-models-dev: retryPolicy'),
    catalogProvider,
  }
}

/** The effective anonymous posture of one route after profile layering. */
export function resolveAnonymous(config: Config, provider: string): boolean {
  return config.providers?.[provider]?.anonymous ?? declared(provider)?.anonymous ?? false
}

/** Reject a section this adapter could not serve, where it is written. */
export function assertServiceable(config: Config): void {
  const routes = Object.keys(config.providers ?? {})
  if (routes.length === 0) {
    // No profile to judge: resolve a declared route profilelessly so the
    // section's own fields still face their bounds.
    // A declared id literal: the array index itself carries no narrowing.
    resolveAdapterOptions(config, 'opencode-free')
    return
  }
  for (const provider of routes) resolveAdapterOptions(config, provider)
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  const cache = new Map<string, ResolvedModelsDevOptions>()
  const options = (provider: string): ResolvedModelsDevOptions => {
    const raw = current()
    const cached = cache.get(provider)
    if (raw === lastRaw && cached !== undefined) return cached
    try {
      const next = resolveAdapterOptions(raw, provider)
      lastRaw = raw
      cache.set(provider, next)
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the route's last good facts and say so once per bad
      // snapshot (the memoized hit above serves the repeats silently).
      if (cached === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-models-dev: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return cached
    }
  }

  assertServiceable(config)

  const resolveApiKey = async (provider: string, connection: OpenAIConnectionOptions): Promise<string> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(connection.apiKeyEnv)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-models-dev', connection.apiKeyEnv)
    } else {
      const ambient = process.env[connection.apiKeyEnv]
      if (ambient !== undefined && ambient.length > 0) {
        return assertUsableApiKey(ambient, 'llm-models-dev', connection.apiKeyEnv)
      }
    }
    if (resolveAnonymous(current(), provider)) return ZEN_ANONYMOUS_KEY
    throw new LlmError(
      `llm-models-dev: no API key for provider route "${provider}"; store ${connection.apiKeyEnv}`
      + ' through the credentials service (the web Models page writes it), or export'
      + ` ${connection.apiKeyEnv} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  const catalog = new ModelsDevCatalog(
    config.catalogURL ?? DEFAULT_CATALOG_URL,
    config.catalogRefreshMs ?? DEFAULT_CATALOG_REFRESH_MS,
  )
  const adapter = new ModelsDevAdapter({
    options,
    resolveApiKey,
    resolveUserId,
    catalog,
    // The anonymous Zen free tier is client-gated: without these facts the
    // gateway answers MissingSessionID regardless of model or key. Sent on
    // every route in this family — OpenCode itself stamps them regardless of
    // authentication — and the conversation session id scopes the gateway's
    // per-session free-quota bucket to this conversation.
    extraHeaders: (_provider, _connection, sessionId) => ({
      'user-agent': ZEN_CLIENT_USER_AGENT,
      'x-session-id': sessionId ?? fallbackSessionId,
    }),
    onCatalogError: (error) => {
      ctx.logger.warn('llm-models-dev: serving the last good catalog snapshot after a failed refresh')
      ctx.logger.warn(error)
    },
  })

  ctx.llm.registerConfigurableProviders(DECLARED.map(({ provider, displayName }) => ({
    provider,
    displayName,
    settingsNs: NS,
    settingsPath: ['providers', provider],
  })))

  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const routes = Object.keys(current().providers ?? {})
    const first = routes.at(0)
    const facts = {
      routes: routes.slice().sort((left, right) => left.localeCompare(right)),
      retryPolicy: first === undefined ? undefined : options(first).retryPolicy,
    }
    if (deepEqualJson(facts, registeredFacts)) return
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // profiles, and an empty section keeps it that way.
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      // `replace` re-reads the captured facts in one synchronous registry
      // section: disposing and re-registering instead would publish an empty
      // route set between the two, and an observer that reacted to it would
      // see this provider disappear and come back.
      registration.replace(routes)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  installSettingsSection(ctx, NS, Config, config, {
    validate: assertServiceable,
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      try {
        ensureRegistrationFacts()
      } catch (error) {
        ctx.logger.error('llm-models-dev: keeping the previously registered routes after a refused update')
        ctx.logger.error(error)
      }
    },
  })
}
