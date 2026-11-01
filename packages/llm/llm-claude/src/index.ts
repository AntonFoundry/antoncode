/**
 * Register the `claude-code` provider route on `ctx.llm`: Claude models
 * over the Anthropic Messages API authenticated with the operator's Claude
 * Code subscription OAuth session (device-style browser login, approved
 * once, refreshed silently). Transport reuses pi-ai's Anthropic
 * implementation wholesale — it already sends Claude Code identity for
 * `sk-ant-oat` tokens — so this plugin owns only auth, routing, and
 * capability surface: no wire code, no message translation.
 *
 * Without a session the route fails `MISSING_CREDENTIAL` naming the login
 * fix; gateway rejections keep their code and gain the same guidance in the
 * message. Connection facts resolve per settings snapshot instead of
 * freezing at load. The one registration-captured fact — the retry policy —
 * re-registers the route in place when it changes.
 *
 * @module @deepseek-ai/dsh-llm-claude
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges the loader's `Fiber.entry`, which names this entry's
// settings namespace.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  RetryPolicySchema,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type RetryPolicyConfig,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  authContextFrom,
  buildProvider,
  catalogModels,
  credentialStoreFrom,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  PiAiAdapter,
  type ResolvedPiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CLAUDE_CATALOG_PROVIDER, resolveClaudeAccess } from './claude.ts'
import { ClaudeLoginFlow, CLAUDE_OAUTH_SERVICE } from './claude-login-flow.ts'
import { DEFAULT_OAUTH_REF } from './claude-oauth.ts'

export {
  CLAUDE_BASE_URL,
  CLAUDE_CATALOG_PROVIDER,
  CLAUDE_OAUTH_ENV,
  resolveClaudeAccess,
} from './claude.ts'
export {
  CLAUDE_CONSOLE_URL,
  CLAUDE_MANUAL_REDIRECT_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_SCOPES,
  DEFAULT_OAUTH_REF,
  ClaudeOAuthError,
  createAuthorizeFlow,
  createPkcePair,
  exchangeCode,
  isAccessValid,
  parseOAuthState,
  refreshAccessToken,
  runClaudeLogin,
} from './claude-oauth.ts'
export { ClaudeLoginFlow, CLAUDE_OAUTH_SERVICE } from './claude-login-flow.ts'
export type {
  ClaudeLoginFlowOptions,
  ClaudeLoginPhase,
  ClaudeLoginSnapshot,
} from './claude-login-flow.ts'
export type {
  ClaudeAuthorizeFlow,
  ClaudeLoginInteraction,
  ClaudeOAuthState,
  OAuthCredentialSink,
  OAuthCredentialSource,
} from './claude-oauth.ts'

export const name = 'llm-claude'
export const inject = ['llm']

/** The single provider route this plugin owns. */
export const PROVIDER = 'claude-code'
/** Selector label for this route. */
export const DISPLAY_NAME = 'Claude Code'

/** Positive context fallback used when a model has no exact value. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Default per-request output cap; explicit request values win. */
export const DEFAULT_MAX_TOKENS = 16_384
/** Ceiling for one admitted turn, from prompt admission to terminal outcome. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-claude` settings-section shape. Every field is optional: an
 * empty section registers the route with pure discovery, and a request
 * without a stored session fails with the login fix, not at plugin load.
 */
export interface Config {
  /** Credential reference holding the Claude OAuth session (JSON); defaults to `CLAUDE_CODE_OAUTH`. */
  oauthRef?: string
  /**
   * Anthropic gateway base override; the catalog models keep theirs when
   * omitted. Deployments pointing at a compatible gateway (and tests
   * against scripted ones) set this instead of re-describing every model.
   */
  baseURL?: string
  /** Selector label for this route. */
  displayName?: string
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /** Positive idle ceiling while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

export const Config: z<Config> = z.object({
  oauthRef: z.string().role('credential-ref').default(DEFAULT_OAUTH_REF),
  baseURL: z.string(),
  displayName: z.string().default(DISPLAY_NAME),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** One resolution's validated connection facts. */
export interface ResolvedClaudeOptions {
  /** Validated credential reference holding the Claude OAuth session. */
  oauthRef: CredentialRef
  /** Anthropic gateway base override; `undefined` keeps catalog endpoints. */
  baseURL?: string
  /** Selector label for this route. */
  displayName: string
  /** Positive idle ceiling while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned retry policy. */
  retryPolicy: ReturnType<typeof resolveRetryPolicy>
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Every default and bound is re-judged here — for the composition
 * entry at load (fail loud) and for each settings snapshot at its first use.
 */
export function resolveAdapterOptions(config: Config): ResolvedClaudeOptions {
  if (config.oauthRef !== undefined && config.oauthRef.length === 0) {
    throw new Error('llm-claude: oauthRef must be non-empty')
  }
  if (config.displayName !== undefined && config.displayName.length === 0) {
    throw new Error('llm-claude: displayName must be non-empty')
  }
  if (config.baseURL !== undefined && config.baseURL.length === 0) {
    throw new Error('llm-claude: baseURL must be non-empty')
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('llm-claude: defaultContextWindow must be a positive integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-claude: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    oauthRef: credentialRef(config.oauthRef ?? DEFAULT_OAUTH_REF),
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    displayName: config.displayName ?? DISPLAY_NAME,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-claude: retryPolicy'),
  }
}

/** Login guidance appended to credential failures so the chat turn names the fix. */
export const LOGIN_HINT = 'Run `dsh claude-login` (or the Log in button on the Models page) to log the claude-code route into a Claude subscription, then retry.'

/**
 * `claude-code` adapter: pi-ai Anthropic transport with per-request OAuth
 * credentials. The inner adapter serves discovery, facts, and turns; this
 * layer resolves the session (refreshing silently), hands pi-ai the raw
 * access token it already treats as Claude Code identity, and names the
 * login fix on credential failures.
 */
export interface ClaudeCodeAdapterOptions {
  /** Inner pi-ai adapter serving the `claude-code` profile. */
  inner: PiAiAdapter
}

export class ClaudeCodeAdapter extends LlmAdapter {
  constructor(private readonly options: ClaudeCodeAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return this.options.inner.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.options.inner.providerRetryPolicy(provider)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.options.inner.listModels(provider)
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.options.inner.resolveModel(provider, model, signal)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.run(options)
  }

  private async * run(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    try {
      for await (const chunk of this.options.inner.stream(options)) {
        // pi-ai normalizes gateway failures into a terminal error finish;
        // re-raise auth ones with the login fix so both direct consumers and
        // the runtime (which refolds throws the same way) carry guidance.
        if (chunk.type === 'finish'
          && chunk.reason.kind === 'error'
          && chunk.reason.failure.code === 'AUTH') {
          throw new LlmError(
            `${chunk.reason.failure.message}\n${LOGIN_HINT}`,
            chunk.reason.failure.code,
            { cause: chunk.reason.failure },
          )
        }
        yield chunk
      }
    } catch (error: unknown) {
      if (error instanceof LlmError && (error.code === 'AUTH' || error.code === 'MISSING_CREDENTIAL')) {
        throw new LlmError(`${error.message}\n${LOGIN_HINT}`, error.code, { cause: error })
      }
      throw error
    }
  }
}

/**
 * Build the inner pi-ai adapter serving one `claude-code` profile: the
 * installed Anthropic catalog provider's wire implementation and model
 * facts (the same a keyed `anthropic` route would serve), with per-request
 * OAuth credentials instead of a stored key. Exported so tests drive the
 * identical construction against scripted gateways.
 */
export function createInnerAdapter(options: {
  displayName: string
  streamIdleTimeoutMs: number
  retryPolicy: ResolvedRetryPolicy
  oauthRef: CredentialRef
  models: Parameters<typeof buildProvider>[0]['models']
  baseURL?: string
  resolveAccess: () => Promise<string>
  /**
   * Durable attachment store, used only to convert image blocks. Omission
   * is why this route silently degraded every image to placeholder text:
   * pi-ai's adapter strips images when `resolveAttachments` yields
   * `undefined`, independently of whether the model declares `image`
   * input — and the Anthropic catalog does declare it for these models.
   * Supplied as a resolver rather than a value so a service appearing or
   * disappearing after registration is observed per request, matching how
   * the keyed pi-ai route wires the same seam.
   *
   * Typed off `PiAiAdapter`'s own config rather than importing
   * `AttachmentStore` directly: this package deliberately owns no wire or
   * content code (see the module header) and has no `dsh-attachment`
   * dependency, so deriving the type keeps that boundary intact and can
   * never drift from what the adapter actually accepts.
   */
  resolveAttachments?: ConstructorParameters<typeof PiAiAdapter>[0]['resolveAttachments']
  /**
   * The auth injectables the pi-ai collection is built with. Required by the
   * adapter rather than defaulted: a collection built without them gets an
   * in-memory store that is empty at every boot, so a subscription login would
   * read as unconfigured on the next request.
   */
  auth: ConstructorParameters<typeof PiAiAdapter>[0]['auth']
}): PiAiAdapter {
  // Re-stamp catalog models to this route: pi-ai resolves the serving
  // provider from `model.provider`, so inherited `anthropic` stamps would
  // miss the `claude-code` collection entry with `Unknown provider`.
  // An explicit baseURL repoints the same models at a compatible gateway.
  const models = options.models.map(model => ({
    ...model,
    provider: PROVIDER,
    ...(options.baseURL === undefined ? {} : { baseUrl: options.baseURL }),
  }))
  return new PiAiAdapter({
    auth: options.auth,
    profiles: () => new Map<string, ResolvedPiAiProviderProfile>([[
      PROVIDER,
      {
        provider: PROVIDER,
        displayName: options.displayName,
        apiKeyEnv: options.oauthRef,
        streamIdleTimeoutMs: options.streamIdleTimeoutMs,
        // The image budgets default to pi-ai's own, so this route and a keyed
        // pi-ai route size request images identically.
        maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
        requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
        requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
        retryPolicy: options.retryPolicy,
        modelErrors: new Map(),
        piProvider: buildProvider({
          provider: PROVIDER,
          displayName: options.displayName,
          models,
          api: 'anthropic-messages',
          namesCredential: true,
        }),
        configuredMaxTokens: new Map(),
      },
    ]]),
    resolveApiKey: () => options.resolveAccess(),
    ...(options.resolveAttachments === undefined
      ? {}
      : { resolveAttachments: options.resolveAttachments }),
  })
}

export function apply(ctx: Context, config: Config): void {
  // Settings are Config-derived: an edit reloads the entry and re-applies the
  // plugin, so the resolved facts are fixed for one application.
  const settingsNs = ctx.fiber.entry?.options.id ?? name
  const resolved = resolveAdapterOptions(config)

  const credentialsOf = (): { resolve: (ref: CredentialRef) => Promise<{ value: string } | undefined> } | undefined => {
    const credentials = ctx.get('credentials')
    return credentials === undefined ? undefined : { resolve: ref => credentials.resolve(ref) }
  }
  // A valid stored session selects subscription inference; absence fails the
  // request with the login fix. Runs per operation so a login reaches the
  // very next request — and a removal falls back to the refusal — without
  // re-registration.
  const resolveAccess = async (): Promise<string> => {
    const credentials = ctx.get('credentials')
    const access = await resolveClaudeAccess(
      resolved.oauthRef,
      credentialsOf(),
      credentials === undefined ? undefined : { set: (ref, value) => credentials.set(ref, value) },
    )
    if (access === undefined) {
      throw new LlmError(
        `claude-code has no usable Claude subscription session. ${LOGIN_HINT}`,
        'MISSING_CREDENTIAL',
      )
    }
    return access
  }

  const models = [...catalogModels(CLAUDE_CATALOG_PROVIDER).values()]
  const adapter = new ClaudeCodeAdapter({
    inner: createInnerAdapter({
      displayName: resolved.displayName,
      streamIdleTimeoutMs: resolved.streamIdleTimeoutMs,
      retryPolicy: resolved.retryPolicy,
      oauthRef: resolved.oauthRef,
      models,
      ...(resolved.baseURL === undefined ? {} : { baseURL: resolved.baseURL }),
      resolveAccess,
      // Same seam the keyed pi-ai route wires (llm-pi-ai/src/index.ts):
      // resolved per request so a late-registering attachment service is
      // picked up without re-registering this route.
      resolveAttachments: () => ctx.get('attachments'),
      // One store and one ambient context per plugin instance, read through
      // `ctx` per call, exactly as the keyed pi-ai route builds them.
      auth: { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) },
    }),
  })

  // UI-driven logins share the paste-back flow and the credential seam with
  // the CLI: one provided flow per install, disposal-safe.
  const loginFlow = new ClaudeLoginFlow({
    credentialsOf: () => {
      const credentials = ctx.get('credentials')
      return credentials === undefined ? undefined : { resolve: (ref: string) => credentials.resolve(ref as never) }
    },
    store: async (ref, value) => {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new LlmError('cannot store the Claude session without the credentials service', 'MISSING_CREDENTIAL')
      await credentials.set(ref, value)
    },
    oauthRefOf: () => resolved.oauthRef,
  })
  ctx.effect(() => {
    const unprovide = ctx.provide(CLAUDE_OAUTH_SERVICE, loginFlow)
    return () => {
      loginFlow.dispose()
      unprovide()
    }
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Claude Code', settingsNs, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
