/**
 * Register the `opengateway` provider route on `ctx.llm`: one route over
 * OpenGateway's OpenAI-compatible gateway, authenticated with a stored
 * `OPENGATEWAY_API_KEY`.
 *
 * Discovery reads the gateway's own `GET /models` catalog — the same document
 * its dashboard renders — and lists every active text model with the context
 * window, output cap, and wire protocol it advertises. Streaming rides the
 * inherited llm-openai transport; a model the gateway serves through the
 * OpenAI Responses protocol takes that protocol, and every other model uses
 * chat-completions. A failed catalog refresh keeps serving the last good
 * snapshot, so a gateway outage never empties a working picker.
 *
 * Connection facts resolve per operation, so an endpoint or key change reaches
 * the very next request without re-registration. The one registration-captured
 * fact — the retry policy — re-registers the route in place when it changes.
 *
 * @module @deepseek-ai/dsh-llm-opengateway
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  assertUsableApiKey,
  LlmError,
  resolveRetryPolicy,
  RetryPolicySchema,
  type AdapterRegistrationHandle,
  type RetryPolicyConfig,
} from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  VERBATIM_REASONING_EFFORTS,
} from '@deepseek-ai/dsh-llm-openai'
import type { OpenAIConnectionOptions } from '@deepseek-ai/dsh-llm-openai'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { OpenGatewayAdapter, type OpenGatewayConnectionOptions, type OpenGatewayReasoningEffort } from './adapter.ts'
import { OpenGatewayCatalog } from './catalog.ts'

export { OpenGatewayAdapter } from './adapter.ts'
export type {
  OpenGatewayAdapterOptions,
  OpenGatewayConnectionOptions,
  OpenGatewayReasoningEffort,
} from './adapter.ts'
export { OpenGatewayCatalog, parseModels } from './catalog.ts'
export type { OpenGatewayModel } from './catalog.ts'

export const name = 'llm-opengateway'
export const inject = ['llm']

const NS = settingsNamespace('llm-opengateway')

/** The single provider route this plugin owns. */
export const PROVIDER = 'opengateway'

/** OpenGateway's public OpenAI-compatible endpoint. */
export const DEFAULT_BASE_URL = 'https://apis.opengateway.ai/v1'

/** Credential reference resolved per request when the section names none. */
export const DEFAULT_API_KEY_ENV = 'OPENGATEWAY_API_KEY'

/**
 * Catalog re-fetch cadence: models and their pricing rotate quickly on the
 * gateway, and a query against an older snapshot refetches on read.
 */
export const DEFAULT_CATALOG_REFRESH_MS = 28_800_000

/**
 * Efforts offered on every model of this route. The gateway publishes no
 * per-model effort metadata, so the route advertises the same ladder OpenCode
 * defaults to for an OpenAI-compatible provider and leaves the provider
 * default unset. The gateway maps a level to the selected provider's control;
 * which levels a model honors remains model-dependent.
 */
export const DEFAULT_REASONING_EFFORTS: readonly OpenGatewayReasoningEffort[] = ['low', 'medium', 'high']

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-opengateway` settings-section shape. Every field is optional:
 * an empty section serves discovery anonymously and fails a generation with
 * `MISSING_CREDENTIAL` naming the key to store, not at plugin load.
 */
export interface Config {
  /** Endpoint base; `/chat/completions`, `/responses`, and `/models` are appended. */
  baseURL?: string
  /** Credential reference naming the OpenGateway bearer key. */
  apiKeyEnv?: string
  /** Selector label for this route. */
  displayName?: string
  /** Extra provider-specific HTTP headers sent with each request. */
  headers?: Record<string, string>
  /** Catalog re-fetch cadence in milliseconds. */
  catalogRefreshMs?: number
  /**
   * Reasoning levels the picker offers on every model of this route, in
   * display order. Which levels a model honors is gateway- and model-dependent;
   * an empty list hides the effort control and sends none.
   */
  reasoningEfforts?: OpenGatewayReasoningEffort[]
  /** Default per-request output cap; explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

export const Config: z<Config> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  displayName: z.string().default('OpenGateway'),
  headers: z.dict(z.string()),
  catalogRefreshMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CATALOG_REFRESH_MS),
  reasoningEfforts: z.array(z.union([...VERBATIM_REASONING_EFFORTS]))
    .default([...DEFAULT_REASONING_EFFORTS]),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** One resolution's complete request facts. */
export interface ResolvedOpenGatewayOptions extends OpenAIConnectionOptions {
  /** Endpoint base whose `/models` document this route lists. */
  catalogBaseURL: string
  /** Efforts offered on every model of this route, in display order. */
  reasoningEfforts: readonly OpenGatewayReasoningEffort[]
  /** Validated credential reference naming the bearer key. */
  apiKeyEnv: CredentialRef
  /** Validated catalog re-fetch cadence captured by the mount-time refresh loop. */
  catalogRefreshMs: number
}

/**
 * Validate one route's effort ladder. An empty ladder is the explicit opt-out
 * that hides the control; a repeated or undocumented label is a configuration
 * error, because the gateway would receive a value it does not define.
 * @param efforts - the configured ladder, or undefined for the route default.
 * @returns the detached, validated ladder.
 */
function resolveReasoningEfforts(
  efforts: readonly OpenGatewayReasoningEffort[] | undefined,
): OpenGatewayReasoningEffort[] {
  const levels = efforts ?? DEFAULT_REASONING_EFFORTS
  const seen = new Set<OpenGatewayReasoningEffort>()
  for (const level of levels) {
    if (!VERBATIM_REASONING_EFFORTS.includes(level)) {
      throw new Error(`llm-opengateway: unknown reasoning effort ${JSON.stringify(level)}`)
    }
    if (seen.has(level)) throw new Error(`llm-opengateway: reasoningEfforts repeats ${JSON.stringify(level)}`)
    seen.add(level)
  }
  return [...levels]
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or a resolved settings snapshot.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(config: Config): ResolvedOpenGatewayOptions {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  if (baseURL.length === 0) throw new Error('llm-opengateway: baseURL must be non-empty')
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  if (apiKeyEnv.length === 0) throw new Error('llm-opengateway: apiKeyEnv must be non-empty')
  const displayName = config.displayName ?? 'OpenGateway'
  if (displayName.length === 0) throw new Error('llm-opengateway: displayName must be non-empty')
  const catalogRefreshMs = config.catalogRefreshMs ?? DEFAULT_CATALOG_REFRESH_MS
  if (!Number.isInteger(catalogRefreshMs) || catalogRefreshMs <= 0 || catalogRefreshMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-opengateway: catalogRefreshMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const reasoningEfforts = resolveReasoningEfforts(config.reasoningEfforts)
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('llm-opengateway: maxTokens must be a positive safe integer')
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('llm-opengateway: defaultContextWindow must be a positive integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-opengateway: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return {
    baseURL,
    catalogBaseURL: baseURL,
    apiKeyEnv: credentialRef(apiKeyEnv),
    displayName,
    ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
    catalogRefreshMs,
    reasoningEfforts,
    defaults: { reasoningDialect: 'gateway' },
    maxTokens,
    defaultContextWindow,
    models: [],
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-opengateway: retryPolicy'),
  }
}

/**
 * Resolve the bearer key for one request: the managed credential store first,
 * then the launching environment.
 * @param ctx - plugin context carrying the optional credentials seam.
 * @param ref - the credential reference to resolve.
 * @returns the usable key, or `undefined` when no key exists anywhere.
 * @throws LlmError when the stored value is not a usable header value.
 */
export async function resolveStoredApiKey(
  ctx: Context,
  ref: CredentialRef,
): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-opengateway', ref)
    return undefined
  }
  const ambient = launchEnvironmentOf(ctx).get(ref)
  if (ambient === undefined || ambient.value.length === 0) return undefined
  return assertUsableApiKey(ambient.value, 'llm-opengateway', ref)
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let resolved = resolveAdapterOptions(current())
  const catalog = new OpenGatewayCatalog(resolved.catalogRefreshMs)
  const onCatalogError = (error: unknown): void => {
    ctx.logger.warn('llm-opengateway: serving the last good model catalog after a failed refresh')
    ctx.logger.warn(error)
  }
  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  const options = (): OpenGatewayConnectionOptions => resolved
  const adapter = new OpenGatewayAdapter({
    options,
    resolveApiKey: async (_provider, connection) => {
      const ref = (connection as ResolvedOpenGatewayOptions).apiKeyEnv
      const key = await resolveStoredApiKey(ctx, ref)
      if (key === undefined) {
        throw new LlmError(
          `llm-opengateway: no API key; store ${ref} through the credentials service`
          + ` (the web Models page writes it), or export ${ref} in the launching environment`,
          'MISSING_CREDENTIAL',
        )
      }
      return key
    },
    resolveUserId,
    catalog,
    modelProtocol: (_provider, model) => catalog.peekProtocol(resolved.catalogBaseURL, model) ?? 'chat-completions',
    onCatalogError,
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: resolved.displayName, settingsNs: NS, settingsPath: [] },
  ])
  const registration: AdapterRegistrationHandle = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = resolved.retryPolicy

  // Warm discovery at mount and on cadence: a restart converges without
  // waiting for a picker query, and a failed refresh keeps the last snapshot.
  void catalog.refresh(resolved.catalogBaseURL, onCatalogError)
  ctx.effect(() => {
    // The mount-time cadence: a settings-layer change takes effect on the
    // next restart, like the models.dev family's `catalogRefreshMs`.
    const timer = setInterval(
      () => {
        void catalog.refresh(resolved.catalogBaseURL, onCatalogError)
      },
      resolved.catalogRefreshMs,
    )
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
        ctx.logger.error('llm-opengateway: keeping the last good configuration after an invalid settings section')
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
