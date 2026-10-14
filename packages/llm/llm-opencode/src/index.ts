/**
 * Register an {@link OpenCodeServerAdapter} for the `opencode` provider route
 * on `ctx.llm`: generations run inside the user's own opencode server (the
 * only path OpenCode's free tier serves), with the server URL discovered per
 * request from explicit config, `OPENCODE_SERVER_URL`, or live `opencode
 * service status`, and the Basic password read per request from the CLI's
 * service file with `OPENCODE_SERVER_PASSWORD` as fallback. Connection facts
 * resolve per settings snapshot instead of freezing at load, so a changed
 * endpoint reaches the very next request while an in-flight stream keeps the
 * facts it started with. The one registration-captured fact — the retry
 * policy — re-registers the route in place when it changes.
 * @module @deepseek-ai/dsh-llm-opencode
 */

import type { Context } from '@deepseek-ai/cordis'
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
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { OpenCodeServerAdapter, type OpenCodeServerConnection } from './adapter.ts'
import { DEFAULT_PASSWORD_ENV, resolveServerTransport } from './transport.ts'

export { OpenCodeServerAdapter } from './adapter.ts'
export type { OpenCodeServerAdapterOptions, OpenCodeServerConnection } from './adapter.ts'
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

const NS = settingsNamespace('llm-opencode')
/** The single provider route this plugin owns. */
export const PROVIDER = 'opencode-free'

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-opencode` settings-section shape. Every field is optional: an
 * empty section registers the route with pure discovery (CLI status URL plus
 * the service-file password), and a request without any reachable server
 * fails `TRANSPORT`, not at plugin load.
 */
export interface Config {
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
  serverURL: z.string(),
  username: z.string(),
  serviceFile: z.string(),
  passwordFile: z.string(),
  passwordEnv: z.string().default(DEFAULT_PASSWORD_ENV),
  autoStart: z.boolean().default(true),
  directory: z.string(),
  displayName: z.string().default('OpenCode Free'),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  requestTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** One resolution's complete request facts. */
export type ResolvedOpenCodeServerOptions = OpenCodeServerConnection

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
    ...(config.serverURL === undefined ? {} : { serverURL: config.serverURL }),
    ...(config.username === undefined ? {} : { username: config.username }),
    ...(config.serviceFile === undefined ? {} : { serviceFile: config.serviceFile }),
    ...(config.passwordFile === undefined ? {} : { passwordFile: config.passwordFile }),
    passwordEnv: config.passwordEnv ?? DEFAULT_PASSWORD_ENV,
    autoStart: config.autoStart ?? true,
    directory: config.directory ?? process.cwd(),
    displayName: config.displayName ?? 'OpenCode Free',
    requestTimeoutMs,
    maxTokens,
    defaultContextWindow,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-opencode: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  // Eager facts: re-resolved on every settings change below, so requests
  // always read the latest validated snapshot without per-call memo state.
  // An invalid snapshot keeps the previous facts (fail loud only at load).
  let resolved = resolveAdapterOptions(config)
  const adapter = new OpenCodeServerAdapter({
    options: () => resolved,
    transport: () => resolveServerTransport(resolved),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'OpenCode Free', settingsNs: NS, settingsPath: [] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = resolved.retryPolicy
  const refresh = (): void => {
    const previous = resolved
    try {
      resolved = resolveAdapterOptions(current())
    } catch (error) {
      ctx.logger.error('llm-opencode: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      resolved = previous
    }
    // The registry captures the retry policy at registration: re-read it in
    // one synchronous section on change, so no request observes a gap.
    const policy = resolved.retryPolicy
    if (!deepEqualJson(policy, registeredPolicy)) {
      registration.replace([PROVIDER])
      registeredPolicy = policy
    }
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: refresh,
  })
}
