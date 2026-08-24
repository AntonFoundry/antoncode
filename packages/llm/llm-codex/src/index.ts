/**
 * Register a {@link CodexAdapter} for the `codex` provider route while the
 * `providers` dict of its configuration names one — the plugin's
 * `cordis.yml` entry config layered under the optional `llm-codex`
 * user-settings section (`ctx.settings`). The route exists only while its
 * profile is present: the declared directory entry stays dormant (offered by
 * configuration surfaces, serving no requests) until a profile lands, and
 * drops again when it leaves. Authentication is the OpenAI Codex
 * **subscription** OAuth session: the plugin reads the shared
 * `~/.codex/auth.json` login (the same one the Codex CLI and VS Code Codex
 * extension use), refreshing the access token through the OpenAI OAuth
 * endpoint with the stored refresh token. There is no API key anywhere in
 * the configuration — no key input box, by design.
 *
 * The registration-captured facts — the route's presence, selector label,
 * Codex home (which the captured login-readiness answer reads), and the
 * retry policy — re-register the route in place when they change.
 *
 * @module @deepseek-ai/dsh-llm-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  CodexAdapter,
} from './adapter.ts'
import type { CodexCatalogModel, CodexConnectionOptions } from './adapter.ts'
import { codexHomeOf, resolveAccessToken } from './auth.ts'

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  CodexAdapter,
} from './adapter.ts'
export type { CodexAdapterOptions, CodexCatalogModel, CodexConnectionOptions } from './adapter.ts'
export { CODEX_CLIENT_ID, codexHomeOf, readAuth, refreshToken, resolveAccessToken } from './auth.ts'
export type { CodexTokenSet, CodexAuthSnapshot } from './auth.ts'
export type { RequestDefaults } from './serialize.ts'
export type * from './types.ts'

export const name = 'llm-codex'
export const inject = ['llm']

const NS = settingsNamespace('llm-codex')
/** The single provider route this plugin owns. */
const PROVIDER = 'codex'
/** The route's selector label when its profile names none. */
const DEFAULT_DISPLAY_NAME = 'OpenAI Codex'

/** Default Codex backend endpoint. */
export const PUBLIC_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/**
 * Advisory default catalog (observed on a ChatGPT/Codex subscription via the
 * CLI's models cache). The adapter additionally discovers the subscription's
 * live model list from `~/.codex/models_cache.json` when present, so the
 * picker always reflects what the account actually supports.
 */
const DEFAULT_MODELS: CodexCatalogModel[] = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 400_000, maxTokens: 32_768 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 400_000, maxTokens: 32_768 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 400_000, maxTokens: 32_768 },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400_000, maxTokens: 32_768 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 400_000, maxTokens: 32_768 },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 400_000, maxTokens: 32_768 },
]

/**
 * Sparse per-route overrides of the section defaults; the `providers` dict
 * key IS the route id. The key's presence configures and registers the
 * route; its absence leaves the route dormant. A profile may legitimately
 * be empty — authentication is the shared Codex login, so there is no
 * credential field to fill.
 */
export interface CodexProviderProfile {
  /** Codex home directory holding `auth.json` for this route; defaults to the section's, then $CODEX_HOME or `~/.codex`. */
  codexHome?: string
  /** Codex backend base URL for this route; defaults to the section's, then the public chatgpt.com Codex endpoint. */
  baseURL?: string
  /** Selector label for this route; defaults to `OpenAI Codex`. */
  displayName?: string
}

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-codex` settings-section shape. The section fields are the
 * shared defaults the route falls back to; {@link Config.providers} holds
 * the route's profile. Deliberately NO API key field: authentication always
 * comes from the shared Codex login. A missing or expired login fails per
 * request with `MISSING_CREDENTIAL`/`AUTH` and a pointer to `codex login` —
 * never a key prompt.
 */
export interface Config {
  /** Codex home directory holding `auth.json`; defaults to $CODEX_HOME or `~/.codex`. */
  codexHome?: string
  /** Codex backend base URL; defaults to the public chatgpt.com Codex endpoint. */
  baseURL?: string
  /** Default reasoning effort (`off`/`low`/`high`/`max`; `max` maps to the wire's highest level). */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Default per-request output cap; a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 400,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to the Codex catalog. */
  models?: CodexCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
  /**
   * Provider routes keyed by route id; the only route this adapter serves is
   * `codex`. An empty (or omitted) dict is the dormant posture: the adapter
   * mounts with no route and registers it the moment a settings section
   * supplies the profile.
   */
  providers?: Record<string, CodexProviderProfile>
}

const catalogModel: z<CodexCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

const profile: z<CodexProviderProfile> = z.object({
  codexHome: z.string(),
  baseURL: z.string(),
  displayName: z.string(),
})

export const Config: z<Config> = z.object({
  codexHome: z.string(),
  baseURL: z.string(),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  providers: z.dict(profile).default({}),
})

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly CodexCatalogModel[] | undefined): CodexCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-codex: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-codex: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-codex: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-codex: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    if (seen.has(model.id)) throw new Error(`llm-codex: duplicate catalog model "${model.id}"`)
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

/**
 * The one explicit resolve step from raw config to the route's validated
 * connection facts: the section fields are the shared defaults and the
 * route's own profile overrides the per-route fields. Programmatic
 * construction may bypass Schemastery normalization, so every default and
 * bound is re-judged here.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param provider - the route to resolve. It need not hold a profile: a
 * profileless resolution is the section's own judgment, which is how a
 * dormant section still fails loud.
 * @returns validated connection facts (no credential fields — auth is the
 *   shared Codex login, resolved per request).
 */
export function resolveAdapterOptions(config: Config, provider: string): CodexConnectionOptions {
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-codex: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-codex: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-codex: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const route = config.providers?.[provider]
  if (route?.baseURL !== undefined && route.baseURL.length === 0) {
    throw new Error(`llm-codex: provider "${provider}" has an empty baseURL`)
  }
  if (route?.displayName !== undefined && route.displayName.length === 0) {
    throw new Error(`llm-codex: provider "${provider}" has an empty displayName`)
  }
  return {
    baseURL: (route?.baseURL ?? config.baseURL ?? PUBLIC_BASE_URL).replace(/\/$/, ''),
    codexHome: codexHomeOf(route?.codexHome ?? config.codexHome),
    displayName: route?.displayName ?? DEFAULT_DISPLAY_NAME,
    defaults: {
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-codex: retryPolicy'),
  }
}

/**
 * Reject a section this adapter could not serve. Registered as the settings
 * namespace's validator, so an unserviceable write is refused where it is
 * *written* instead of being stored and then failing the route's next
 * request. The only route this adapter serves is {@link PROVIDER}; any other
 * dict key is refused here rather than silently registering a route whose
 * requests could never authenticate. A dormant section still judges its
 * shared fields.
 * @param config - the resolved section to check.
 * @throws Error naming the offending field or route.
 */
export function assertServiceable(config: Config): void {
  const routes = Object.keys(config.providers ?? {})
  for (const provider of routes) {
    if (provider !== PROVIDER) {
      throw new Error(`llm-codex: provider route "${provider}" is not served by this adapter; the only route is "${PROVIDER}"`)
    }
    resolveAdapterOptions(config, provider)
  }
  if (routes.length === 0) {
    // No profile to judge: resolve the route profilelessly so the section's
    // own fields still face their bounds.
    resolveAdapterOptions(config, PROVIDER)
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  const cache = new Map<string, CodexConnectionOptions>()
  /**
   * Per-route resolution, memoized by the raw snapshot's identity — which is
   * also what makes the adapter's own snapshot stable across operations that
   * observe no change.
   */
  const options = (provider: string): CodexConnectionOptions => {
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
      ctx.logger.error('llm-codex: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return cached
    }
  }
  // Fail loud at load on anything the schema could not express, dormant or not.
  assertServiceable(config)

  const resolveAuth = async (connection: CodexConnectionOptions): Promise<{ accessToken: string; accountId?: string }> => {
    const session = await resolveAccessToken(connection.codexHome)
    return {
      accessToken: session.access_token,
      ...session.account_id === undefined ? {} : { accountId: session.account_id },
    }
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  const resolveAttachments = (): AttachmentStore | undefined => ctx.get('attachments')
  const adapter = new CodexAdapter({ options, resolveAuth, resolveUserId, resolveAttachments })
  // The directory entry is static: the route keeps its settings address
  // while dormant, which is what lets a configuration surface offer it and
  // add it back after a removal.
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: DEFAULT_DISPLAY_NAME, settingsNs: NS, settingsPath: ['providers', PROVIDER] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below. A bare
  // mount (no profile) is the dormant posture: nothing registers until a
  // settings section supplies the profile, and the route drops when it
  // leaves.
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const routes = Object.keys(current().providers ?? {})
    // The registry captures the route set, the route's providerInfo label and
    // login-readiness answer (read from codexHome), and the retry policy at
    // registration, so a change to any must re-register.
    const facts = routes.map(provider => {
      const connection = options(provider)
      return {
        provider,
        displayName: connection.displayName,
        codexHome: connection.codexHome,
        retryPolicy: connection.retryPolicy,
      }
    })
    if (deepEqualJson(facts, registeredFacts)) return
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // the profile, and an empty section keeps it that way.
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      // `replace` re-reads the captured facts in one synchronous registry
      // section: disposing and re-registering instead would publish an empty
      // route set between the two.
      registration.replace(routes)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  installSettingsSection(ctx, NS, Config, config, {
    // Refuse an unserviceable section where it is written: without this a
    // schema-valid profile the adapter cannot serve would be stored and then
    // fail the route's next request instead of the write.
    validate: assertServiceable,
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      // A refused swap leaves the previous routes serving and
      // `registeredFacts` put, so returning to a working configuration
      // re-applies.
      try {
        ensureRegistrationFacts()
      } catch (error) {
        ctx.logger.error('llm-codex: keeping the previously registered routes after a refused update')
        ctx.logger.error(error)
      }
    },
  })
}
