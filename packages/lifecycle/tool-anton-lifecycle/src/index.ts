/**
 * Model-facing Anton lifecycle tools. Each tool is a thin HTTP round-trip to the Anton Bridge
 * supervisor (`apps/anton-bridge`), the out-of-process owner of the harness child process and the
 * c0ntext engine — the harness can never supervise its own process, so the bridge stays the
 * authority and this plugin only exposes its control API to the model.
 *
 * `anton_stop` and `anton_restart` terminate the very process executing the call, so their
 * contracts state the self-termination semantics explicitly: the current turn ends mid-call and
 * only refusal or delay produces a rendered result.
 *
 * @module @deepseek-ai/dsh-tool-anton-lifecycle
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolRunContext } from '@deepseek-ai/dsh-tools'

export const name = 'tool-anton-lifecycle'
export const inject = ['tools']

/** Default control endpoint of the bundled Anton Bridge. */
const DEFAULT_BRIDGE_ENDPOINT = 'http://127.0.0.1:3742'
/** Environment variable consulted before the configured default endpoint. */
const DEFAULT_BRIDGE_ENDPOINT_ENV = 'ANTON_BRIDGE_ENDPOINT'

/** Per-call fetch timeouts. Start and restart wait out the bridge's own readiness polling (up to 30s), so they get headroom above it. */
const TIMEOUT_MS = {
  status: 15_000,
  start: 45_000,
  stop: 20_000,
  restart: 60_000,
} as const

/** Model-facing lifecycle tool configuration. */
export interface Config {
  /**
   * Control endpoint of the Anton Bridge supervisor. Deployments embedding the bridge on another
   * host or port override this; the bundled app keeps the default.
   */
  bridgeEndpoint?: string
  /** Environment variable that overrides `bridgeEndpoint` at process launch. */
  bridgeEndpointEnv?: string
  /** Register the `anton_status` diagnostics tool. Defaults to `true`. */
  statusToolEnabled?: boolean
  /** Register the `anton_start` recovery tool. Defaults to `true`. */
  startToolEnabled?: boolean
  /** Register the `anton_stop` shutdown tool. Defaults to `true`. */
  stopToolEnabled?: boolean
  /** Register the `anton_restart` redeploy tool. Defaults to `true`. */
  restartToolEnabled?: boolean
}

/** Schemastery configuration for the lifecycle tool consumer. */
export const Config: z<Config> = z.object({
  bridgeEndpoint: z.string().default(DEFAULT_BRIDGE_ENDPOINT),
  bridgeEndpointEnv: z.string().default(DEFAULT_BRIDGE_ENDPOINT_ENV),
  statusToolEnabled: z.boolean().default(true),
  startToolEnabled: z.boolean().default(true),
  stopToolEnabled: z.boolean().default(true),
  restartToolEnabled: z.boolean().default(true),
})

/**
 * Resolve the bridge control endpoint for this process launch: an environment override wins over
 * the configured value so one deployment image can be re-pointed without editing its config.
 * Misconfiguration fails loud here at load time — a non-HTTP endpoint can never succeed.
 * @param config - the deployment's lifecycle configuration.
 * @returns the endpoint without a trailing slash.
 */
function endpoint(config: Config): string {
  const override = process.env[config.bridgeEndpointEnv ?? DEFAULT_BRIDGE_ENDPOINT_ENV]?.trim()
  const value = (override === undefined || override === '' ? config.bridgeEndpoint : override) ?? DEFAULT_BRIDGE_ENDPOINT
  const normalized = value.replace(/\/$/, '')
  if (!/^https?:\/\//.test(normalized)) {
    throw new Error(`tool-anton-lifecycle bridgeEndpoint must use http or https, got ${JSON.stringify(value)}`)
  }
  return normalized
}

/** One structured result block from the bridge, passed through to the model verbatim. */
type BridgePayload = Record<string, JsonValue>

/**
 * Render one bridge payload as its verbatim JSON text. The payloads are already compact,
 * model-oriented status objects produced by the bridge, so no reshaping happens here.
 * @param _args - unused; these tools take no arguments.
 * @param value - the parsed bridge response.
 * @returns one text block carrying the payload's JSON.
 */
function renderPayload(_args: Record<string, never>, value: Record<string, JsonValue>): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Perform one bridge round-trip and parse its JSON body.
 * @param base - resolved bridge endpoint without trailing slash.
 * @param path - control API path beginning with `/bridge/api/`.
 * @param method - HTTP verb for the call.
 * @param signal - caller-owned cancellation composed with the per-tool timeout.
 * @param timeoutMs - hard deadline for the whole call.
 * @returns the parsed JSON response.
 * @throws when the bridge is unreachable or answers with a non-OK status.
 */
async function bridgeRequest(base: string, path: string, method: 'GET' | 'POST', signal: AbortSignal, timeoutMs: number): Promise<BridgePayload> {
  let response: Response
  try {
    response = await fetch(`${base}${path}`, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) })
  } catch (error: unknown) {
    throw new Error(`Anton Bridge at ${base} did not answer ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new Error(`Anton Bridge refused ${method} ${path} with ${response.status}: ${await response.text()}`)
  }
  return await response.json() as BridgePayload
}

/** The shared output schema: every tool returns whatever structured status JSON the bridge produced. */
const BRIDGE_OUTPUT = { type: 'object', additionalProperties: true } as const

/**
 * Execute `anton_status`: report bridge, harness, and engine health verbatim.
 * @param config - deployment configuration supplying the endpoint.
 * @param exec - execution context providing the caller's cancellation signal.
 * @returns the bridge's full status payload.
 */
async function statusExecute(config: Config, exec: ToolRunContext): Promise<BridgePayload> {
  return await bridgeRequest(endpoint(config), '/bridge/api/status', 'GET', exec.signal, TIMEOUT_MS.status)
}

/**
 * Execute `anton_start`: bring up a stopped harness. When everything already runs, the bridge
 * reports that nothing needed starting, which is the normal outcome of a speculative call.
 * @param config - deployment configuration supplying the endpoint.
 * @param exec - execution context providing the caller's cancellation signal.
 * @returns the bridge's start result plus refreshed status.
 */
async function startExecute(config: Config, exec: ToolRunContext): Promise<BridgePayload> {
  return await bridgeRequest(endpoint(config), '/bridge/api/harness/start', 'POST', exec.signal, TIMEOUT_MS.start)
}

/**
 * Execute `anton_stop`: shut down the harness process. This request cannot complete normally —
 * the bridge stops THIS process mid-call — so the response path below only renders when the stop
 * was refused (externally managed, bridge down).
 * @param config - deployment configuration supplying the endpoint.
 * @param exec - execution context providing the caller's cancellation signal.
 * @returns a refusal note when readable; normally the process dies before any return.
 */
async function stopExecute(config: Config, exec: ToolRunContext): Promise<BridgePayload> {
  // Deliberately not routed through bridgeRequest: a refused stop must throw loud, while our own
  // death mid-fetch surfaces as a network error that still means the stop was carried out.
  const base = endpoint(config)
  try {
    const response = await fetch(`${base}/bridge/api/harness/stop`, { method: 'POST', signal: AbortSignal.any([exec.signal, AbortSignal.timeout(TIMEOUT_MS.stop)]) })
    if (!response.ok) throw new Error(`Anton Bridge refused the stop (${response.status}): ${await response.text()}`)
    return { status: 'stopped', result: await response.json() as BridgePayload }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Anton Bridge refused')) throw error
    return { status: 'stop_requested', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute `anton_restart`: cycle the harness so freshly deployed code takes effect. As with
 * `anton_stop`, the bridge terminates THIS process mid-call; only refusal or delay renders.
 * @param config - deployment configuration supplying the endpoint.
 * @param exec - execution context providing the caller's cancellation signal.
 * @returns the post-restart status when the call somehow completes; usually never returns.
 */
async function restartExecute(config: Config, exec: ToolRunContext): Promise<BridgePayload> {
  const base = endpoint(config)
  try {
    return {
      status: 'restarted',
      result: await bridgeRequest(base, '/bridge/api/harness/restart', 'POST', exec.signal, TIMEOUT_MS.restart),
    }
  } catch (error: unknown) {
    // Expected outcome: our own process died mid-request. A refusal throws inside bridgeRequest
    // with the "refused" prefix, so it re-throws below instead of masquerading as success.
    if (error instanceof Error && error.message.startsWith('Anton Bridge refused')) throw error
    return { status: 'restart_requested', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Register the enabled lifecycle tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit lifecycle policy.
 * @throws at load when the resolved endpoint is not HTTP(S) (misconfiguration fails loud).
 */
export function apply(ctx: Context, config: Config): void {
  // Resolve once at registration so a bad endpoint rejects the plugin entry during boot instead of
  // surfacing as a per-call error later.
  endpoint(config)

  if (config.statusToolEnabled !== false) {
    ctx.tools.register(defineTool({
      name: 'anton_status',
      description: 'Report the health of the Anton application services: the supervisor bridge, the agent runtime process (with PID and port), and the c0ntext memory engine. Use this to diagnose whether a service is down before attempting anton_start or anton_restart.',
      parameters: {},
      output: { schema: BRIDGE_OUTPUT, render: renderPayload },
      isConcurrencySafe: () => true,
      execute: (_args, exec) => statusExecute(config, exec),
    }))
  }

  if (config.startToolEnabled !== false) {
    ctx.tools.register(defineTool({
      name: 'anton_start',
      description: 'Start the agent runtime service if it is stopped, reporting what it did. When everything already runs, it reports that nothing needed starting — safe to call speculatively while diagnosing.',
      parameters: {},
      output: { schema: BRIDGE_OUTPUT, render: renderPayload },
      isConcurrencySafe: () => false,
      execute: (_args, exec) => startExecute(config, exec),
    }))
  }

  if (config.stopToolEnabled !== false) {
    ctx.tools.register(defineTool({
      name: 'anton_stop',
      description: 'Shut down the agent runtime service. WARNING: you ARE that process — calling this ends your current turn and conversation immediately, and the user brings the app back from its control surface. Call it ONLY when the user explicitly asks to stop or quit the application, never mid-task.',
      parameters: {},
      output: { schema: BRIDGE_OUTPUT, render: renderPayload },
      isConcurrencySafe: () => false,
      execute: (_args, exec) => stopExecute(config, exec),
    }))
  }

  if (config.restartToolEnabled !== false) {
    ctx.tools.register(defineTool({
      name: 'anton_restart',
      description: 'Restart the agent runtime service so freshly deployed code takes effect. Call this ONLY after a build/deploy step completed (e.g. a plugin or bundle was rebuilt), never mid-task: it terminates this very process, so the CURRENT turn ends immediately and the user starts a new conversation on the restarted app. Do not call it speculatively or more than once per deployment.',
      parameters: {},
      output: { schema: BRIDGE_OUTPUT, render: renderPayload },
      isConcurrencySafe: () => false,
      execute: (_args, exec) => restartExecute(config, exec),
    }))
  }
}
