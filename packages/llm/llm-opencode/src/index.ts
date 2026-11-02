/**
 * Register the `opencode-free` provider route on `ctx.llm`: one route over
 * three transports, picked per request. A logged-in Zen workspace session
 * (device-flow OAuth, approved once in the browser) selects the direct
 * inference gateway with workspace identity — the only path that serves
 * free-tier models with tool calling today; zero-cost turns additionally
 * take the free-tier gate (identity headers, marker/flattened history,
 * text-protocol tools parsed back into harness calls). A stored Zen bearer
 * key selects direct Zen generation with native Harness tool schemas.
 * Without either, the route serves the user's own OpenCode service through
 * transient text generation; when no service is reachable either, the
 * request falls through to anonymous direct and surfaces the gateway's
 * real verdict. Returned tool calls always execute through Harness tools,
 * never through OpenCode's local agent loop. Connection facts resolve per
 * settings snapshot instead of freezing at load. The one
 * registration-captured fact — the retry policy — re-registers the route
 * in place when it changes.
 * @module @deepseek-ai/dsh-llm-opencode
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: merges the loader's `Fiber.entry`, which names this entry's
// settings namespace.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import {
  resolveRetryPolicy,
  RetryPolicySchema,
  type RetryPolicyConfig,
} from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_CONTEXT_WINDOW,
} from '@deepseek-ai/dsh-llm-openai'
import { ModelsDevAdapter, ModelsDevCatalog } from '@deepseek-ai/dsh-llm-models-dev'
import type { ModelsDevConnectionOptions } from '@deepseek-ai/dsh-llm-models-dev'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { OpenCodeServerAdapter, type OpenCodeServerConnection } from './adapter.ts'
import { OpenCodeRouterAdapter } from './router.ts'
import { DEFAULT_PASSWORD_ENV, resolveServerTransport } from './transport.ts'
import {
  OPENCODE_API_KEY_ENV,
  ZEN_BASE_URL,
  ZEN_CATALOG_PROVIDER,
  resolveRealKey,
  resolveZenApiKey,
  resolveZenHeaders,
  type ZenCredentialSource,
} from './zen.ts'
import {
  DEFAULT_INFERENCE_BASE_URL,
  DEFAULT_OAUTH_REF,
  ZEN_OAUTH_UA,
  LlmOAuthError,
  isAccessValid,
  parseOAuthState,
  refreshAccessToken,
} from './zen-oauth.ts'
import {
  freeTierHeaders,
  shapeFreeTierBody,
} from './zen-gate.ts'
import { ZenLoginFlow, OPENCODE_OAUTH_SERVICE } from './zen-login-flow.ts'

export { OpenCodeServerAdapter } from './adapter.ts'
export type { OpenCodeServerAdapterOptions, OpenCodeServerConnection } from './adapter.ts'
export { OpenCodeRouterAdapter } from './router.ts'
export type { OpenCodeRouterOptions } from './router.ts'
export {
  OPENCODE_API_KEY_ENV,
  ZEN_ANONYMOUS_KEY,
  ZEN_BASE_URL,
  ZEN_CATALOG_PROVIDER,
  resolveRealKey,
  resolveZenApiKey,
  resolveZenHeaders,
} from './zen.ts'
export {
  DEFAULT_INFERENCE_BASE_URL,
  DEFAULT_OAUTH_REF,
  ZEN_OAUTH_UA,
  isAccessValid,
  parseOAuthState,
  refreshAccessToken,
  runZenLogin,
} from './zen-oauth.ts'
export type { ZenLoginInteraction, ZenOAuthState, ZenOrg } from './zen-oauth.ts'
export { ZenLoginFlow, OPENCODE_OAUTH_SERVICE } from './zen-login-flow.ts'
export type {
  ZenLoginFlowOptions,
  ZenLoginPhase,
  ZenLoginSnapshot,
  ZenLoginCredentialSink,
} from './zen-login-flow.ts'
export {
  augmentSystemWithTextProtocol,
  buildTextToolProtocol,
  extractToolBlocks,
  freeTierHeaders,
  freeTierSessionId,
  parseFreeTextTools,
  shapeFreeTierBody,
  GATE_PREAMBLE,
  ZEN_MARKER_PROMPT,
} from './zen-gate.ts'
export {
  DEFAULT_PASSWORD_ENV,
  DEFAULT_USERNAME,
  EXECUTABLE_ENV,
  SERVER_URL_ENV,
  resolveServerTransport,
} from './transport.ts'
export type { OpenCodeServerTransportConfig, ServerTransport, TransportSystem } from './transport.ts'

export const name = 'llm-opencode'
export const inject = ['llm']

/** The single provider route this plugin owns. */
export const PROVIDER = 'opencode-free'

/** The models.dev root the direct transport reads the `opencode` free tier from. */
export const DEFAULT_CATALOG_URL = 'https://models.dev'
/**
 * Direct-transport catalog re-fetch cadence: the document republishes
 * continuously, and a query against an older snapshot refetches on read.
 */
export const DEFAULT_CATALOG_REFRESH_MS = 28_800_000

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-opencode` settings-section shape. Every field is optional: an
 * empty section registers the route with pure discovery (Zen anonymous
 * transport plus CLI-status service URL and the service-file password), and
 * a request without any reachable generation path fails with the real
 * downstream verdict, not at plugin load.
 */
export interface Config {
  /** Use the registered OpenCode service explicitly, or select by stored credentials. */
  transport?: 'auto' | 'service'
  /** OpenCode agent used by service sessions; configure its system prompt for Harness delegation. */
  agent?: string
  /** Explicit server base URL; skips file and CLI discovery. */
  serverURL?: string
  /** Basic-auth username; defaults to `opencode`. */
  username?: string
  /** Server registration-file path; defaults to the CLI state-home `service.json`. */
  serviceFile?: string
  /** Password-file path; defaults to `~/.config/opencode/service.json`. */
  passwordFile?: string
  /** Environment variable holding the password fallback. */
  passwordEnv?: string
  /** Start the OpenCode background service when none is running; defaults to true. */
  autoStart?: boolean
  /** Working directory the server scopes sessions to; defaults to the launch directory. */
  directory?: string
  /** Selector label for this route. */
  displayName?: string
  /** Credential reference naming the Zen bearer key; defaults to `OPENCODE_API_KEY`. */
  apiKeyEnv?: string
  /**
   * Credential reference holding the Zen OAuth workspace session (JSON);
   * defaults to `OPENCODE_ZEN_OAUTH`. Written by the login flow, read and
   * silently refreshed per request.
   */
  oauthRef?: string
  /** Direct Zen gateway base; `/chat/completions` and `/responses` are appended. */
  zenBaseURL?: string
  /** OAuth inference gateway base; the workspace session talks here instead of {@link zenBaseURL}. */
  inferenceBaseURL?: string
  /** Catalog root fetched as `<catalogURL>/api.json` for direct-transport discovery. */
  catalogURL?: string
  /** Direct-transport re-fetch cadence: the mount fetches eagerly, then this interval re-fetches. */
  catalogRefreshMs?: number
  /** Default per-request output cap; explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /** Ceiling for one admitted turn, from prompt admission to terminal outcome. */
  requestTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

export const Config: z<Config> = z.object({
  transport: z.union(['auto', 'service']).default('auto'),
  agent: z.string().min(1),
  serverURL: z.string(),
  username: z.string(),
  serviceFile: z.string(),
  passwordFile: z.string(),
  passwordEnv: z.string().default(DEFAULT_PASSWORD_ENV),
  autoStart: z.boolean().default(true),
  directory: z.string(),
  displayName: z.string().default('OpenCode Free'),
  apiKeyEnv: z.string().role('credential-ref').default(OPENCODE_API_KEY_ENV),
  oauthRef: z.string().role('credential-ref').default(DEFAULT_OAUTH_REF),
  zenBaseURL: z.string().default(ZEN_BASE_URL),
  inferenceBaseURL: z.string().default(DEFAULT_INFERENCE_BASE_URL),
  catalogURL: z.string().default(DEFAULT_CATALOG_URL),
  catalogRefreshMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CATALOG_REFRESH_MS),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  requestTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** One resolution's complete request facts: the service transport plus the direct Zen transport. */
export interface ResolvedOpenCodeServerOptions extends OpenCodeServerConnection {
  /** Explicit service routing bypasses direct gateway credentials and fallback. */
  transport: 'auto' | 'service'
  /** Validated credential reference naming the Zen bearer key. */
  apiKeyEnv: CredentialRef
  /** Validated credential reference holding the Zen OAuth workspace session. */
  oauthRef: CredentialRef
  /** Direct Zen gateway base. */
  zenBaseURL: string
  /** OAuth inference gateway base. */
  inferenceBaseURL: string
  /** Catalog root the direct transport reads the `opencode` free tier from. */
  catalogURL: string
  /** Direct-transport catalog re-fetch cadence in milliseconds. */
  catalogRefreshMs: number
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 */
export function resolveAdapterOptions(config: Config): ResolvedOpenCodeServerOptions {
  if (config.serverURL !== undefined && config.serverURL.length === 0) {
    throw new Error('llm-opencode: serverURL must be non-empty')
  }
  if (config.username !== undefined && config.username.length === 0) {
    throw new Error('llm-opencode: username must be non-empty')
  }
  if (config.serviceFile !== undefined && config.serviceFile.length === 0) {
    throw new Error('llm-opencode: serviceFile must be non-empty')
  }
  if (config.passwordFile !== undefined && config.passwordFile.length === 0) {
    throw new Error('llm-opencode: passwordFile must be non-empty')
  }
  if (config.passwordEnv !== undefined && config.passwordEnv.length === 0) {
    throw new Error('llm-opencode: passwordEnv must be non-empty')
  }
  if (config.directory !== undefined && config.directory.length === 0) {
    throw new Error('llm-opencode: directory must be non-empty')
  }
  if (config.displayName !== undefined && config.displayName.length === 0) {
    throw new Error('llm-opencode: displayName must be non-empty')
  }
  if (config.apiKeyEnv !== undefined && config.apiKeyEnv.length === 0) {
    throw new Error('llm-opencode: apiKeyEnv must be non-empty')
  }
  if (config.oauthRef !== undefined && config.oauthRef.length === 0) {
    throw new Error('llm-opencode: oauthRef must be non-empty')
  }
  if (config.zenBaseURL !== undefined && config.zenBaseURL.length === 0) {
    throw new Error('llm-opencode: zenBaseURL must be non-empty')
  }
  if (config.inferenceBaseURL !== undefined && config.inferenceBaseURL.length === 0) {
    throw new Error('llm-opencode: inferenceBaseURL must be non-empty')
  }
  if (config.catalogURL !== undefined && config.catalogURL.length === 0) {
    throw new Error('llm-opencode: catalogURL must be non-empty')
  }
  const catalogRefreshMs = config.catalogRefreshMs ?? DEFAULT_CATALOG_REFRESH_MS
  if (!Number.isInteger(catalogRefreshMs) || catalogRefreshMs <= 0 || catalogRefreshMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-opencode: catalogRefreshMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('llm-opencode: maxTokens must be a positive safe integer')
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('llm-opencode: defaultContextWindow must be a positive integer')
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(requestTimeoutMs)
    || requestTimeoutMs <= 0
    || requestTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-opencode: requestTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    transport: config.transport ?? 'auto',
    ...(config.agent === undefined ? {} : { agent: config.agent }),
    ...(config.serverURL === undefined ? {} : { serverURL: config.serverURL }),
    ...(config.username === undefined ? {} : { username: config.username }),
    ...(config.serviceFile === undefined ? {} : { serviceFile: config.serviceFile }),
    ...(config.passwordFile === undefined ? {} : { passwordFile: config.passwordFile }),
    passwordEnv: config.passwordEnv ?? DEFAULT_PASSWORD_ENV,
    autoStart: config.autoStart ?? true,
    directory: config.directory ?? process.cwd(),
    displayName: config.displayName ?? 'OpenCode Free',
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? OPENCODE_API_KEY_ENV),
    oauthRef: credentialRef(config.oauthRef ?? DEFAULT_OAUTH_REF),
    zenBaseURL: config.zenBaseURL ?? ZEN_BASE_URL,
    inferenceBaseURL: config.inferenceBaseURL ?? DEFAULT_INFERENCE_BASE_URL,
    catalogURL: config.catalogURL ?? DEFAULT_CATALOG_URL,
    catalogRefreshMs,
    requestTimeoutMs,
    maxTokens,
    defaultContextWindow,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-opencode: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false, editableConfig: true }, ctx.fiber)) })
  // Settings are Config-derived: an edit reloads the entry and re-applies the
  // plugin, so the resolved facts are fixed for one application.
  const settingsNs = ctx.fiber.entry?.options.id ?? name
  const resolved = resolveAdapterOptions(config)

  const credentialsOf = (): ZenCredentialSource | undefined => {
    const credentials = ctx.get('credentials')
    return credentials === undefined ? undefined : { resolve: ref => credentials.resolve(ref) }
  }
  // A logged-in workspace session selects the inference gateway; else a
  // real stored key selects direct Zen; absence of both selects the
  // service. Runs per operation so a login or a stored key reaches the very
  // next request — and a removal falls back — without re-registration.
  const resolveOAuthAccess = async (): Promise<{
    access: string
    orgID?: string
    allowedModels?: readonly string[]
  } | undefined> => {
    const credentials = ctx.get('credentials')
    let raw: string | undefined
    try {
      raw = credentials !== undefined
        ? (await credentials.resolve(resolved.oauthRef))?.value
        : process.env[resolved.oauthRef]
    } catch {
      return undefined
    }
    const state = parseOAuthState(raw)
    if (state === undefined) return undefined
    if (isAccessValid(state)) {
      return {
        access: state.access,
        ...(state.orgID === undefined ? {} : { orgID: state.orgID }),
        ...(state.allowedModels === undefined ? {} : { allowedModels: state.allowedModels }),
      }
    }
    let next
    try {
      next = await refreshAccessToken(state, { signal: AbortSignal.timeout(30_000) })
    } catch {
      return undefined
    }
    if (credentials !== undefined) {
      await credentials.set(resolved.oauthRef, JSON.stringify(next)).catch((error: unknown) => {
        ctx.logger.warn('llm-opencode: renewed Zen workspace token stays request-local; the stored copy could not be updated')
        ctx.logger.warn(error)
      })
    }
    return {
      access: next.access,
      ...(next.orgID === undefined ? {} : { orgID: next.orgID }),
      ...(next.allowedModels === undefined ? {} : { allowedModels: next.allowedModels }),
    }
  }

  const catalog = new ModelsDevCatalog(
    resolved.catalogURL,
    resolved.catalogRefreshMs,
  )
  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  const onCatalogError = (error: unknown): void => {
    ctx.logger.warn('llm-opencode: serving the last good catalog snapshot after a failed refresh')
    ctx.logger.warn(error)
  }
  const zenConnection = (snapshot: ResolvedOpenCodeServerOptions): ModelsDevConnectionOptions => ({
    apiKeyEnv: snapshot.apiKeyEnv,
    baseURL: snapshot.zenBaseURL,
    displayName: snapshot.displayName,
    defaults: {},
    maxTokens: snapshot.maxTokens,
    defaultContextWindow: snapshot.defaultContextWindow,
    models: [],
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: snapshot.retryPolicy,
    catalogProvider: ZEN_CATALOG_PROVIDER,
  })
  const direct = new ModelsDevAdapter({
    options: () => zenConnection(resolved),
    resolveApiKey: async (_provider, connection) =>
      resolveZenApiKey(connection.apiKeyEnv ?? credentialRef(OPENCODE_API_KEY_ENV), credentialsOf()),
    resolveUserId,
    catalog,
    // Zen client identity rides every direct request, scoped to this route
    // only: the session id is required (the gateway answers MissingSessionID
    // without one), with real Harness session/request identifiers throughout.
    extraHeaders: (_provider, _connection, sessionId, requestId) =>
      resolveZenHeaders(sessionId, requestId),
    // The catalog declares each model's wire protocol: Muse Spark on Zen
    // serves only Responses, and chat-completions for it is a hard 500.
    modelProtocol: (_provider, model) => catalog
      .peekProtocol(ZEN_CATALOG_PROVIDER, model) === 'responses'
      ? 'responses'
      : 'chat-completions',
    onCatalogError,
  })
  const service = new OpenCodeServerAdapter({
    options: () => resolved,
    transport: () => resolveServerTransport(resolved),
  })
  // UI-driven logins share the device flow and the credential seam with the
  // CLI: one provided flow per install, request-scoped reads, disposal-safe
  // (pending browser waits abort with the fiber).
  const loginFlow = new ZenLoginFlow({
    credentialsOf,
    store: async (ref, value) => {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new LlmOAuthError('cannot store the Zen session without the credentials service')
      await credentials.set(ref, value)
    },
    oauthRefOf: () => resolved.oauthRef,
  })
  // Per-request OAuth transport: request-scoped facts (token, workspace,
  // free-tier flag) must never leak across concurrent turns, so each call
  // builds its own adapter over the shared catalog.
  const oauthDirectFor = (
    access: string,
    orgID: string | undefined,
    free: boolean,
    protocol: 'chat-completions' | 'responses',
  ): ModelsDevAdapter =>
    new ModelsDevAdapter({
      options: () => ({ ...zenConnection(resolved), baseURL: resolved.inferenceBaseURL }),
      resolveApiKey: () => Promise.resolve(access),
      resolveUserId,
      catalog,
      // Free-tier turns mimic the genuine client byte-identically (exact UA);
      // paid workspace turns keep Harness attribution (no gate to satisfy).
      exactUserAgent: free,
      extraHeaders: () => free
        ? {
          ...freeTierHeaders(),
          ...(orgID === undefined ? {} : { 'x-opencode-org-id': orgID }),
        }
        : {
          'user-agent': ZEN_OAUTH_UA,
          ...(orgID === undefined ? {} : { 'x-opencode-org-id': orgID }),
        },
      modelProtocol: () => protocol,
      transformBody: (body, wire) =>
        free && wire === 'responses' && 'input' in body ? shapeFreeTierBody(body) : body,
      onCatalogError,
    })
  const adapter = new OpenCodeRouterAdapter({
    service,
    direct,
    resolveTransport: async (options) => {
      if (resolved.transport === 'service') {
        return { adapter: service, freeTier: false, via: 'service', serviceOnly: true }
      }
      await direct.listModels(PROVIDER)
      const oauth = await resolveOAuthAccess()
      if (oauth !== undefined) {
        const free = catalog.peekCached(ZEN_CATALOG_PROVIDER)?.has(options.model) ?? false
        // The catalog owns the wire protocol: the live gateway 400s
        // Responses for free models that only serve chat-completions.
        const protocol = catalog.peekProtocol(ZEN_CATALOG_PROVIDER, options.model) === 'responses'
          ? 'responses'
          : 'chat-completions'
        return {
          adapter: oauthDirectFor(oauth.access, oauth.orgID, free, protocol),
          freeTier: free,
          via: 'oauth',
          protocol,
          ...(oauth.allowedModels === undefined ? {} : { allowedModels: oauth.allowedModels }),
        }
      }
      if ((await resolveRealKey(resolved.apiKeyEnv, credentialsOf())) !== undefined) {
        return { adapter: direct, freeTier: false, via: 'keyed' }
      }
      return { adapter: service, freeTier: false, via: 'service' }
    },
  })
  ctx.effect(() => {
    const unprovide = ctx.provide(OPENCODE_OAUTH_SERVICE, loginFlow)
    return () => {
      loginFlow.dispose()
      unprovide()
    }
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'OpenCode Free', settingsNs, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  if (resolved.transport === 'service') return

  // Warm the direct transport's free tier at mount and on cadence, exactly
  // like the models.dev family: a restart converges without waiting for a
  // picker query, and a failed refresh keeps the last good snapshot.
  void catalog.refresh(ZEN_CATALOG_PROVIDER, onCatalogError)
  ctx.effect(() => {
    // The mount-time cadence: a settings-layer change takes effect on the
    // next restart, like the models.dev family's `catalogRefreshMs`.
    const cadence = resolved.catalogRefreshMs
    const timer = setInterval(
      () => {
        void catalog.refresh(ZEN_CATALOG_PROVIDER, onCatalogError)
      },
      cadence,
    )
    return () => {
      clearInterval(timer)
    }
  })

}
