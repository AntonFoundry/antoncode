/**
 * Register an {@link AntigravityAdapter} for the `antigravity` provider route
 * while the `providers` dict of its configuration names one — the plugin's
 * `cordis.yml` entry config layered under the optional `llm-antigravity`
 * user-settings section (`ctx.settings`). Authentication is the Google
 * Antigravity **OAuth** login: the plugin reads the shared
 * `antigravity-accounts.json` account store (the same one the reference
 * Antigravity proxy plugin writes) and silently refreshes the access token
 * through the Google OAuth endpoint. There is no API key anywhere.
 *
 * @module @deepseek-ai/dsh-llm-antigravity
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  AntigravityAdapter,
} from './adapter.ts'
import type { AntigravityCatalogModel, AntigravityConnectionOptions } from './adapter.ts'
import { resolveAccessToken, ANTIGRAVITY_ENDPOINT, accountsPathOf } from './auth.ts'
import { PROVIDER } from './invariant.ts'

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  AntigravityAdapter,
} from './adapter.ts'
export type { AntigravityAdapterOptions, AntigravityCatalogModel, AntigravityConnectionOptions } from './adapter.ts'
export {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  authorizeAntigravity,
  exchangeAntigravity,
  refreshAccessToken,
  resolveAccessToken,
} from './auth.ts'
export type {
  AntigravityAccount,
  AntigravityAuth,
  AntigravityAuthorization,
  AntigravityAccountsFile,
} from './auth.ts'
export { PROVIDER } from './invariant.ts'
export { runLogin } from './login.ts'
export type { LoginOptions } from './login.ts'
export type { AntigravitySseEvent } from './translate.ts'

export const name = 'llm-antigravity'
export const inject = ['llm']

const NS = settingsNamespace('llm-antigravity')
const DEFAULT_DISPLAY_NAME = 'Google Antigravity'

/** Sparse per-route overrides; the `providers` dict key IS the route id. */
export interface AntigravityProviderProfile {
  /** Path to the shared Antigravity accounts file for this route. */
  accountsPath?: string
  /** Antigravity gateway base URL for this route. */
  baseURL?: string
  /** Selector label for this route; defaults to `Google Antigravity`. */
  displayName?: string
}

/** Plugin config, doubling as the `llm-antigravity` settings-section shape. */
export interface Config {
  /** Path to the shared Antigravity accounts file; defaults to `~/.config/opencode/antigravity-accounts.json`. */
  accountsPath?: string
  /** Antigravity gateway base URL; defaults to the daily sandbox endpoint. */
  baseURL?: string
  /** Default per-request output cap. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers. */
  models?: AntigravityCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy. */
  retryPolicy?: RetryPolicyConfig
  /** Provider routes keyed by route id; only `antigravity` is served. */
  providers?: Record<string, AntigravityProviderProfile>
}

const catalogModel: z<AntigravityCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

const profile: z<AntigravityProviderProfile> = z.object({
  accountsPath: z.string(),
  baseURL: z.string(),
  displayName: z.string(),
})

export const Config: z<Config> = z.object({
  accountsPath: z.string(),
  baseURL: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default([...DEFAULT_MODELS]),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  providers: z.dict(profile).default({}),
})

function resolveModels(models: readonly AntigravityCatalogModel[] | undefined): AntigravityCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-antigravity: catalog model ids must be non-empty')
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`llm-antigravity: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`llm-antigravity: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    if (seen.has(model.id)) throw new Error(`llm-antigravity: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }
  })
}

/** Resolve a route's validated connection facts from raw config. */
export function resolveAdapterOptions(config: Config, provider: string): AntigravityConnectionOptions {
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-antigravity: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-antigravity: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-antigravity: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const route = config.providers?.[provider]
  if (route?.baseURL !== undefined && route.baseURL.length === 0) {
    throw new Error(`llm-antigravity: provider "${provider}" has an empty baseURL`)
  }
  if (route?.displayName !== undefined && route.displayName.length === 0) {
    throw new Error(`llm-antigravity: provider "${provider}" has an empty displayName`)
  }
  return {
    baseURL: (route?.baseURL ?? config.baseURL ?? ANTIGRAVITY_ENDPOINT).replace(/\/$/, ''),
    accountsPath: accountsPathOf(route?.accountsPath ?? config.accountsPath),
    displayName: route?.displayName ?? DEFAULT_DISPLAY_NAME,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-antigravity: retryPolicy'),
  }
}

/** Reject a section this adapter could not serve. */
export function assertServiceable(config: Config): void {
  const routes = Object.keys(config.providers ?? {})
  for (const provider of routes) {
    if (provider !== PROVIDER) {
      throw new Error(`llm-antigravity: provider route "${provider}" is not served by this adapter; the only route is "${PROVIDER}"`)
    }
    resolveAdapterOptions(config, provider)
  }
  if (routes.length === 0) {
    resolveAdapterOptions(config, PROVIDER)
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  const cache = new Map<string, AntigravityConnectionOptions>()

  const options = (provider: string): AntigravityConnectionOptions => {
    const raw = current()
    const cached = cache.get(provider)
    if (raw === lastRaw && cached !== undefined) return cached
    try {
      const next = resolveAdapterOptions(raw, provider)
      lastRaw = raw
      cache.set(provider, next)
      return next
    } catch (error) {
      if (cached === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-antigravity: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return cached
    }
  }
  assertServiceable(config)

  // Resolve a live access token per request, refreshing the shared account
  // store on demand. A missing login fails the request with a clear pointer.
  const resolveAuth = async (): Promise<{ accessToken: string; projectId?: string }> => {
    const connection = options(PROVIDER)
    const auth = await resolveAccessToken(connection.accountsPath)
    return {
      accessToken: auth.accessToken,
      ...auth.projectId === undefined ? {} : { projectId: auth.projectId },
    }
  }

  const adapter = new AntigravityAdapter({ options, resolveAuth })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: DEFAULT_DISPLAY_NAME, settingsNs: NS, settingsPath: ['providers', PROVIDER] },
  ])

  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const routes = Object.keys(current().providers ?? {})
    const facts = routes.map(provider => {
      const connection = options(provider)
      return {
        provider,
        displayName: connection.displayName,
        baseURL: connection.baseURL,
        retryPolicy: connection.retryPolicy,
      }
    })
    if (deepEqualJson(facts, registeredFacts)) return
    if (registration === undefined) {
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  installSettingsSection(ctx, NS, Config, config, {
    validate: assertServiceable,
    setSource: (source) => { current = source },
    onChange: () => {
      try {
        ensureRegistrationFacts()
      } catch (error) {
        ctx.logger.error('llm-antigravity: keeping the previously registered routes after a refused update')
        ctx.logger.error(error)
      }
    },
  })
}
