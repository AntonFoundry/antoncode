/**
 * Register an {@link OpenAIAdapter} for the provider routes named by the
 * `providers` dict of its configuration — the plugin's `cordis.yml` entry
 * config layered under the optional `llm-openai` user-settings section
 * (`ctx.settings`). A route exists only while its dict key is present: the
 * declared `openai` and `openai-compatible` entries stay dormant (offered by
 * configuration surfaces, serving no requests) until a profile lands, and
 * drop again when it leaves. Connection facts resolve per request — a
 * route's profile fields over the section's shared defaults — and the API
 * key resolves through the optional credential seam (`ctx.credentials`), so
 * a changed base URL, catalog, or key reaches the very next request without
 * restarting anything, while an in-flight stream keeps the facts it started
 * with. The registration-captured facts — the route set, each route's
 * selector label, and the retry policy — re-register the routes in place
 * when they change.
 *
 * The `openai-compatible` route is how a local OpenAI installation (LM Studio,
 * vLLM, llama.cpp, Ollama's `/v1` bridge, or any OpenAI-protocol server) joins
 * the harness: same chat-completions protocol, pointed at the local base URL.
 *
 * @module @deepseek-ai/dsh-llm-openai
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OpenAIAdapter,
} from './adapter.ts'
import type { OpenAICatalogModel, OpenAIConnectionOptions } from './adapter.ts'

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OpenAIAdapter,
} from './adapter.ts'
export type { OpenAIAdapterOptions, OpenAICatalogModel, OpenAIConnectionOptions } from './adapter.ts'
export type { RequestDefaults } from './serialize.ts'
export type * from './types.ts'

export const name = 'llm-openai'
export const inject = ['llm']

const NS = settingsNamespace('llm-openai')

/**
 * The provider routes this plugin declares in the configurable-provider
 * directory, with their selector labels: the official API and any
 * OpenAI-compatible installation. The declaration is static so a dormant
 * route keeps its settings address and stays offered by configuration
 * surfaces; profiles under these keys (or any other) make routes live.
 */
const DECLARED: readonly { provider: string; displayName: string }[] = [
  { provider: 'openai', displayName: 'OpenAI' },
  { provider: 'openai-compatible', displayName: 'OpenAI Compatible' },
]

const DEFAULT_MODELS: OpenAICatalogModel[] = [
  { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000, maxTokens: 16_384 },
  { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128_000, maxTokens: 16_384 },
  { id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 1_048_576, maxTokens: 32_768 },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', contextWindow: 1_048_576, maxTokens: 32_768 },
  { id: 'o3', name: 'OpenAI o3', contextWindow: 200_000, maxTokens: 100_000 },
  { id: 'o4-mini', name: 'OpenAI o4-mini', contextWindow: 200_000, maxTokens: 100_000 },
  { id: 'gpt-5', name: 'GPT-5', contextWindow: 400_000, maxTokens: 128_000 },
]

/**
 * Sparse per-route overrides of the section defaults; the `providers` dict
 * key IS the route id. The key's presence configures and registers the
 * route; its absence leaves the route dormant. A profile may be empty — the
 * section defaults and the derived credential reference still serve it.
 */
export interface OpenAIProviderProfile {
  /** Credential reference (environment-variable name) resolved per request for this route alone. */
  apiKeyEnv?: string
  /** Endpoint base for this route; the section value, trusted $OPENAI_BASE_URL, and the public API sit below it. */
  baseURL?: string
  /** Selector label for this route; defaults to the declared route's name, or the route id for an undeclared one. */
  displayName?: string
}

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-openai` settings-section shape. The section fields are the
 * shared defaults every route falls back to; {@link Config.providers} holds
 * the per-route profiles. A missing API key resolves through the profile's
 * or section's {@link Config.apiKeyEnv} at each request (a request without
 * any key fails with `MISSING_CREDENTIAL`, not at plugin load), and an
 * omitted base URL defaults to the public OpenAI API — or point it at a
 * local installation for the `openai-compatible` route.
 */
export interface Config {
  /**
   * Shared credential reference (environment-variable name) resolved per
   * request. A route profile's own `apiKeyEnv` wins; with neither set, the
   * route derives `<ROUTE>_API_KEY` in upper snake (`openai` →
   * `OPENAI_API_KEY`, `openai-compatible` → `OPENAI_COMPATIBLE_API_KEY`) —
   * the same derivation the web Models page stores and cleans up under.
   */
  apiKeyEnv?: string
  /** Shared endpoint base; falls back to $OPENAI_BASE_URL from a trusted environment layer, then the public API. */
  baseURL?: string
  /** Default reasoning effort (`off`/`low`/`high`/`max`; `max` maps to the wire's highest level). */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Default per-request output cap; a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 128,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to the GPT-4o/o-series/GPT-5 catalog. */
  models?: OpenAICatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
  /**
   * Provider routes keyed by route id. An empty (or omitted) dict is the
   * dormant posture: the adapter mounts with no routes and registers them
   * the moment a settings section supplies profiles.
   */
  providers?: Record<string, OpenAIProviderProfile>
}

const catalogModel: z<OpenAICatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

const profile: z<OpenAIProviderProfile> = z.object({
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
  displayName: z.string(),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  providers: z.dict(profile).default({}),
})

/** Public API default; a local installation overrides it through $OPENAI_BASE_URL or settings. */
export const PUBLIC_BASE_URL = 'https://api.openai.com/v1'

/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'OPENAI_BASE_URL'

/**
 * The credential reference a route falls back to when neither its profile
 * nor the section names one — the web Models page's derivation convention
 * (`<ROUTE>_API_KEY`, upper snake), so a key the page stored under that
 * reference is the one the route resolves, and the one the page's removal
 * cleanup unsets. For `openai` this is `OPENAI_API_KEY`.
 * @param provider - the provider route id.
 * @returns the derived credential reference name.
 */
function defaultApiKeyEnv(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** One resolution's complete request facts (same shape as the adapter's connection options). */
export type ResolvedOpenAIOptions = OpenAIConnectionOptions

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly OpenAICatalogModel[] | undefined): OpenAICatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-openai: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-openai: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-openai: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-openai: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    if (seen.has(model.id)) throw new Error(`llm-openai: duplicate catalog model "${model.id}"`)
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
 * The one explicit resolve step from raw config to one route's validated
 * connection facts: the section fields are the shared defaults and the
 * route's own profile overrides the per-route fields. Programmatic
 * construction may bypass Schemastery normalization, so every default and
 * bound is re-judged here — for the composition entry at load (fail loud)
 * and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param provider - the route to resolve. It need not hold a profile: a
 * profileless resolution is the section's own judgment, which is how a
 * dormant section still fails loud.
 * @param environment - this run's environment layers, or `undefined` outside
 * the product CLI. Every layer may supply an endpoint: a local OpenAI
 * installation sets it once and every profile route inherits it.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(config: Config, provider: string, environment?: LaunchEnvironmentSnapshot): ResolvedOpenAIOptions {
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-openai: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-openai: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-openai: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const route = config.providers?.[provider]
  if (route?.apiKeyEnv !== undefined && route.apiKeyEnv.length === 0) {
    throw new Error(`llm-openai: provider "${provider}" has an empty apiKeyEnv`)
  }
  if (route?.baseURL !== undefined && route.baseURL.length === 0) {
    throw new Error(`llm-openai: provider "${provider}" has an empty baseURL`)
  }
  if (route?.displayName !== undefined && route.displayName.length === 0) {
    throw new Error(`llm-openai: provider "${provider}" has an empty displayName`)
  }
  return {
    apiKeyEnv: credentialRef(route?.apiKeyEnv ?? config.apiKeyEnv ?? defaultApiKeyEnv(provider)),
    baseURL: route?.baseURL
      ?? config.baseURL
      ?? environment?.get(BASE_URL_ENV)?.value
      ?? PUBLIC_BASE_URL,
    displayName: route?.displayName
      ?? DECLARED.find(entry => entry.provider === provider)?.displayName
      ?? provider,
    defaults: {
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-openai: retryPolicy'),
  }
}

/**
 * Reject a section this adapter could not serve. Registered as the settings
 * namespace's validator, so a profile failing a beyond-schema bound is
 * refused where it is *written* — `settings.mutate` answers
 * `settings-rejected` with the offending route named — instead of being
 * stored and then failing the route's next request. A dormant section still
 * judges its shared fields.
 * @param config - the resolved section to check.
 * @throws Error naming the offending field or route.
 */
export function assertServiceable(config: Config): void {
  const routes = Object.keys(config.providers ?? {})
  if (routes.length === 0) {
    // No profile to judge: resolve a declared route profilelessly so the
    // section's own fields still face their bounds.
    resolveAdapterOptions(config, 'openai')
    return
  }
  for (const provider of routes) resolveAdapterOptions(config, provider)
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  const cache = new Map<string, ResolvedOpenAIOptions>()
  /**
   * Per-route resolution, memoized by the raw snapshot's identity — which is
   * also what makes the adapter's own snapshot stable across operations that
   * observe no change.
   */
  const options = (provider: string): ResolvedOpenAIOptions => {
    const raw = current()
    const cached = cache.get(provider)
    if (raw === lastRaw && cached !== undefined) return cached
    try {
      const next = resolveAdapterOptions(raw, provider, launchEnvironmentOf(ctx))
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
      ctx.logger.error('llm-openai: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return cached
    }
  }
  // Fail loud at load on anything the schema could not express, dormant or not.
  assertServiceable(config)

  const resolveApiKey = async (provider: string, connection: ResolvedOpenAIOptions): Promise<string> => {
    // Every credential fact comes from the caller's snapshot, so a rejected
    // settings generation cannot leak its key onto the previous endpoint.
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-openai', ref)
    } else {
      // Without the seam there is no managed store to rank against, so the
      // environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-openai', ref)
      }
    }
    throw new LlmError(
      `llm-openai: no API key for provider route "${provider}"; store ${ref} through the`
      + ` credentials service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  const adapter = new OpenAIAdapter({ options, resolveApiKey, resolveUserId })
  // The directory is static: the declared routes keep their settings
  // addresses while dormant, which is what lets a configuration surface
  // offer them and add them back after a removal.
  ctx.llm.registerConfigurableProviders(
    DECLARED.map(({ provider, displayName }) => ({
      provider,
      displayName,
      settingsNs: NS,
      settingsPath: ['providers', provider],
    })),
  )
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below. A bare
  // mount (zero routes) is the dormant posture: nothing registers until a
  // settings section supplies profiles, and routes drop when it empties.
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const routes = Object.keys(current().providers ?? {})
    // The retry policy is a section-level shared default, so any live route
    // answers for all of them; a dormant set carries no policy fact at all.
    const first = routes.at(0)
    // The registry captures the route set, each route's providerInfo label,
    // and the retry policy at registration, so a change to any must
    // re-register. Sorted by route so a settings document that merely
    // reorders its keys is not mistaken for a route change.
    const facts = {
      routes: routes
        .map(provider => ({ provider, displayName: options(provider).displayName }))
        .sort((left, right) => left.provider.localeCompare(right.provider)),
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
    // Refuse an unserviceable section where it is written: without this a
    // schema-valid profile the adapter cannot serve would be stored and then
    // fail the route's next request instead of the write.
    validate: assertServiceable,
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      // A profile claiming a route another adapter family owns is stored
      // successfully and only fails at this swap: the registry refuses the
      // whole candidate set, so the previous routes keep serving, and
      // `registeredFacts` stays put so returning to a working configuration
      // re-applies.
      try {
        ensureRegistrationFacts()
      } catch (error) {
        ctx.logger.error('llm-openai: keeping the previously registered routes after a refused update')
        ctx.logger.error(error)
      }
    },
  })
}
