/**
 * `OpenCodeServerAdapter`: an {@link LlmAdapter} that answers through the
 * user's own running opencode server instead of a third-party gateway.
 *
 * The gateway rejects free-tier calls from anything but genuine OpenCode
 * (`FreeTierError: ... can only be used from within OpenCode`), so stamping
 * more client headers onto direct calls cannot converge — the sustainable
 * path is the server's own HTTP API, exactly what the `opencode api`
 * subcommand speaks: `GET /api/model` lists the server's models (each entry
 * carries its `providerID`, `cost`, `limit.context`, and `variants`), and
 * turns complete through `POST /api/session/:id/generate`, which renders
 * transient text without running the server's agent loop — no server-side
 * tool calls, so no permission prompts nobody answers and no runaway
 * sessions. A server without the generate route fails the request; the
 * adapter never delegates tool execution to OpenCode's agent loop.
 *
 * Responses accept either a `{data}` envelope or a bare payload.
 *
 * @module dsh-llm-opencode/adapter
 */

import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmModelReasoningInfo,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_PASSWORD_ENV,
  type OpenCodeServerTransportConfig,
  type ServerTransport,
} from './transport.ts'

/** One request's validated connection facts (the plugin resolves these per settings snapshot). */
export interface OpenCodeServerConnection extends OpenCodeServerTransportConfig {
  /** Human-readable provider name for selectors. */
  displayName: string
  /** Working directory the server scopes sessions to; defaults to the launch directory. */
  directory: string
  /** Ceiling for one admitted turn, from prompt admission to terminal outcome. */
  requestTimeoutMs: number
  /** Per-request output cap used when the model advertises none. */
  maxTokens: number
  /** Context capacity used when the model advertises none. */
  defaultContextWindow: number
  /** Provider-owned model-request retry policy captured with the registration. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options: per-route connection facts plus the async server transport. */
export interface OpenCodeServerAdapterOptions {
  /** Current validated connection facts for one provider route. */
  options: (provider: string) => OpenCodeServerConnection
  /**
   * Resolve one request's server URL and auth headers; re-runs per call so a
   * server restart (which moves the port) is picked up without re-registration.
   */
  transport: () => Promise<ServerTransport>
}

interface ServerModel {
  id: string
  providerID: string
  name: string
  contextWindow?: number
  /** Reasoning variant ids the server advertises, in server-preferred order. */
  variants: string[]
}

interface WireCost {
  input?: unknown
  output?: unknown
}

interface WireModel {
  id?: unknown
  modelID?: unknown
  providerID?: unknown
  name?: unknown
  cost?: unknown
  limit?: { context?: unknown }
  variants?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function wireCostFree(cost: unknown): boolean {
  if (cost === undefined) return true
  if (Array.isArray(cost)) {
    return cost.every((entry) => {
      if (!isRecord(entry)) return false
      const { input, output } = entry as WireCost
      return (typeof input !== 'number' || input === 0) && (typeof output !== 'number' || output === 0)
    })
  }
  if (isRecord(cost)) {
    const { input, output } = cost as WireCost
    return (typeof input !== 'number' || input === 0) && (typeof output !== 'number' || output === 0)
  }
  return false
}

/**
 * Narrow one raw server model entry to the fields the adapter routes on.
 * @returns the entry, or `undefined` when it is malformed or not zero-cost.
 */
export function toServerModel(raw: unknown): ServerModel | undefined {
  if (!isRecord(raw)) return undefined
  const model = raw as WireModel
  const id = typeof model.modelID === 'string' && model.modelID.length > 0
    ? model.modelID
    : typeof model.id === 'string' && model.id.length > 0
      ? model.id
      : undefined
  const providerID = typeof model.providerID === 'string' && model.providerID.length > 0
    ? model.providerID
    : undefined
  if (id === undefined || providerID === undefined) return undefined
  if (!wireCostFree(model.cost)) return undefined
  const context = isRecord(model.limit) ? model.limit.context : undefined
  const contextWindow = typeof context === 'number' && Number.isInteger(context) && context > 0
    ? context
    : undefined
  return {
    id,
    providerID,
    name: typeof model.name === 'string' && model.name.length > 0 ? model.name : id,
    ...contextWindow === undefined ? {} : { contextWindow },
    variants: wireVariants(model.variants),
  }
}

/** Read a server `variants` array into deduplicated variant ids; anything else means no variants. */
function wireVariants(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const ids: string[] = []
  for (const entry of raw) {
    const id = isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : undefined
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Display label for one server variant id. */
export function variantDisplayName(variant: string): string {
  if (variant === 'xhigh') return 'Extra High'
  return variant.length === 0 ? variant : variant.slice(0, 1).toUpperCase() + variant.slice(1)
}

/**
 * Build the harness reasoning metadata for one model's server variants.
 * `undefined` when the model advertises none, which hides the effort picker
 * for it; the default stays unset so the picker offers the server default.
 */
export function reasoningFor(variants: readonly string[]): LlmModelReasoningInfo | undefined {
  if (variants.length === 0) return undefined
  return {
    efforts: variants.map(variant => ({
      id: ReasoningEffortId(variant),
      name: variantDisplayName(variant),
    })),
  }
}

/**
 * Map one requested harness effort to the server variant it admits.
 * `undefined` (and the harness `off`, which likewise means provider default)
 * omits the variant so the server applies its own default.
 * @throws INVALID_REQUEST when the effort names no advertised variant.
 */
export function variantFor(effort: string | undefined, variants: readonly string[]): string | undefined {
  if (effort === undefined || effort === 'off') return undefined
  if (!variants.includes(effort)) {
    throw new LlmError(
      `llm-opencode: model offers no ${effort} variant`
      + (variants.length > 0 ? ` (available: ${variants.join(', ')})` : ' and advertises no variants'),
      'INVALID_REQUEST',
    )
  }
  return effort
}

/** Zero-cost provider id used when the model was never listed (the free-tier convention). */
export const FALLBACK_PROVIDER_ID = 'opencode'

function statusError(status: number, message: string, url: string): LlmError {
  if (status === 401) {
    return new LlmError(
      `llm-opencode: server at ${url} rejected the request (HTTP 401);`
      + ' store the server password where the transport reads it'
      + ` (service.json, or ${DEFAULT_PASSWORD_ENV})`,
      'AUTH',
      { status },
    )
  }
  if (status === 429) {
    return new LlmError(`llm-opencode: server rate-limited the request: ${message}`, 'RATE_LIMIT', { status })
  }
  if (status >= 500) {
    return new LlmError(`llm-opencode: server failed the request: ${message}`, 'SERVER', { status })
  }
  if (status === 400) {
    return new LlmError(`llm-opencode: server rejected the request: ${message}`, 'INVALID_REQUEST', { status })
  }
  return new LlmError(`llm-opencode: server request failed: ${message}`, `HTTP_${status}`, { status })
}

function transportError(url: string, cause: unknown): LlmError {
  return new LlmError(
    `llm-opencode: no opencode server reachable at ${url}; start one with \`opencode service start\``
    + ' (or launch the opencode TUI), or point serverURL at it',
    'TRANSPORT',
    { cause },
  )
}

function blockText(block: ContentBlock): string | undefined {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text
    case 'tool-call':
      return `[tool call ${block.name} ${block.arguments}]`
    default:
      return undefined
  }
}

function messageHasImage(message: RequestMessage): boolean {
  return message.content.some(block => block.type === 'image')
}

/**
 * Render harness messages to the single text prompt a server session admits.
 * Assistant reasoning and tool traffic render as quoted context. The transient
 * generation route accepts text only, so offered Harness tool schemas stay
 * behind while past tool traffic remains visible. Images have no text
 * representation and are rejected instead of silently dropped.
 */
export function renderPrompt(system: string | undefined, messages: readonly RequestMessage[]): string {
  const sections: string[] = []
  if (system !== undefined && system.length > 0) sections.push(`System: ${system}`)
  for (const message of messages) {
    if (messageHasImage(message)) {
      throw new LlmError('llm-opencode: the opencode server bridge cannot carry image attachments', 'INVALID_REQUEST')
    }
    const text = message.content
      .map(block => blockText(block))
      .filter((entry): entry is string => entry !== undefined)
      .join('\n')
    // A tool result is its own message now; it still renders as the same
    // bracketed line this text-only bridge has always sent.
    if (message.role === 'tool') {
      const marker = `[tool result for ${String(message.toolCallId)}${message.isError === true ? ' (error)' : ''}]`
      sections.push(`User: ${marker}\n${text}`)
      continue
    }
    const role = message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : 'User'
    sections.push(`${role}: ${text}`)
  }
  return sections.join('\n\n')
}

interface AssistantTurn {
  reasoning: string
  text: string
  usage?: TokenUsage
  finish: FinishReason
}

/** Read disjoint provider token counts into harness usage; `undefined` when the payload carries none. */
export function wireTokens(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined
  const tokens = raw as {
    input?: unknown
    output?: unknown
    reasoning?: unknown
    cache?: { read?: unknown; write?: unknown }
  }
  const input = typeof tokens.input === 'number' ? tokens.input : 0
  const output = typeof tokens.output === 'number' ? tokens.output : 0
  const reasoning = typeof tokens.reasoning === 'number' ? tokens.reasoning : undefined
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined
  const read = cache !== undefined && typeof cache.read === 'number' ? cache.read : undefined
  const write = cache !== undefined && typeof cache.write === 'number' ? cache.write : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    ...read === undefined ? {} : { cacheReadTokens: read },
    ...write === undefined ? {} : { cacheWriteTokens: write },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

/** Read one server assistant message into a streamable turn; `undefined` for anything else or empty content. */
export function assistantTurn(raw: unknown): AssistantTurn | undefined {
  if (!isRecord(raw) || raw.type !== 'assistant') return undefined
  const content = Array.isArray(raw.content) ? raw.content : []
  const partText = (kind: string): string => content
    .filter((part): part is { type: unknown; text?: unknown } => isRecord(part) && part.type === kind)
    .map(part => typeof part.text === 'string' ? part.text : '')
    .join('')
  const reasoning = partText('reasoning')
  const text = partText('text')
  if (reasoning.length === 0 && text.length === 0) return undefined
  const usage = wireTokens(raw.tokens)
  return {
    reasoning,
    text,
    ...usage === undefined ? {} : { usage },
    finish: raw.finish === 'length' ? { kind: 'max-tokens' } : { kind: 'stop' },
  }
}

/** Read one server message's terminal outcome; `undefined` until the `idle` marker lands. */
export function idleOutcome(raw: unknown): 'succeeded' | 'failed' | undefined {
  if (!isRecord(raw) || raw.type !== 'idle') return undefined
  return raw.outcome === 'failed' ? 'failed' : 'succeeded'
}

/** Best-effort provider error text from either wire generation's error envelope. */
export function errorMessage(body: unknown): string {
  if (!isRecord(body)) return 'unknown error'
  if (typeof body.message === 'string' && body.message.length > 0) return body.message
  if (isRecord(body.error) && typeof body.error.message === 'string' && body.error.message.length > 0) {
    return body.error.message
  }
  return 'unknown error'
}

/** Abort-aware delay between message polls. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted', { cause: signal.reason }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/** Read transient generated text from either wire generation's envelope. */
export function generatedText(body: unknown): string | undefined {
  const payload = isRecord(body) && body.data !== undefined ? body.data : body
  if (typeof payload === 'string') return payload
  if (!isRecord(payload)) return undefined
  return typeof payload.text === 'string' ? payload.text : undefined
}

function parseModels(body: unknown): ServerModel[] {
  const entries = isRecord(body) && body.data !== undefined ? body.data : body
  if (!Array.isArray(entries)) return []
  const models: ServerModel[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    // The server lists one entry per serving variant, so a model id can
    // repeat (e.g. standard versus priority tiers sharing one modelID). The
    // runtime requires unique ids per provider, so the first entry — the
    // server's preferred ordering — wins and the rest stay reachable only
    // through it.
    const model = toServerModel(entry)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

interface TrackedSession {
  serverID: string
  model: string
  providerID: string
  variant?: string
}

/** The exact server model reference one request admits under, variant included. */
export interface ServerModelRef {
  id: string
  providerID: string
  variant?: string
}

/** Read one request's harness effort as the plain id the server variants use. */
function effortOf(options: GenerateOptions): string | undefined {
  return options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
}

export class OpenCodeServerAdapter extends LlmAdapter {
  readonly #options: (provider: string) => OpenCodeServerConnection
  readonly #transport: () => Promise<ServerTransport>
  readonly #models = new Map<string, ServerModel[]>()
  readonly #sessions = new Map<string, TrackedSession>()

  constructor(options: OpenCodeServerAdapterOptions) {
    super()
    this.#options = options.options
    this.#transport = options.transport
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: this.#options(provider).displayName }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.#options(provider).retryPolicy
  }

  /**
   * List the server's zero-cost models. An unreachable server yields an empty
   * picker — the route stays registered and recovers on the next query —
   * while every answered failure surfaces, so a wrong password is never
   * silent.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    let transport: ServerTransport
    let status: number
    let body: unknown
    try {
      transport = await this.#transport()
      const seen = await this.request(transport, '/api/model', { method: 'GET' })
      status = seen.status
      body = seen.body
    } catch {
      return []
    }
    if (status !== 200) throw statusError(status, errorMessage(body), transport.url)
    const models = parseModels(body)
    this.#models.set(provider, models)
    return models.map(model => ({ provider, id: model.id, name: model.name }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.#options(provider)
    if (this.#models.get(provider) === undefined) await this.listModels(provider)
    const entry = this.#models.get(provider)?.find(candidate => candidate.id === model)
    const reasoning = entry === undefined ? undefined : reasoningFor(entry.variants)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      context: { contextWindow: entry?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: connection.maxTokens,
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.run(options)
  }

  private async request(
    transport: ServerTransport,
    path: string,
    init: { method: string; body?: unknown; signal?: AbortSignal },
  ): Promise<{ status: number; body: unknown }> {
    let response: Response
    try {
      response = await fetch(`${transport.url}${path}`, {
        method: init.method,
        headers: {
          ...transport.headers,
          ...attributionHeaders(),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      })
    } catch (error: unknown) {
      if (init.signal?.aborted === true) throw error
      throw transportError(transport.url, error)
    }
    let body: unknown
    try {
      const text = await response.text()
      body = text.length > 0 ? JSON.parse(text) as unknown : undefined
    } catch {
      body = undefined
    }
    return { status: response.status, body }
  }

  private async * run(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    // The generate route emits text only. Harness tool schemas do not cross
    // this bridge; past tool traffic remains visible as quoted context.
    const connection = this.#options(options.provider)
    const timeout = AbortSignal.timeout(connection.requestTimeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    try {
      const transport = await this.#transport()
      const model = await this.modelRef(options.provider, options.model, effortOf(options))
      const sessionKey = options.sessionId === undefined ? undefined : String(options.sessionId)
      const session = await this.sessionFor(sessionKey, options, connection, transport, model, signal)
      const complete = renderPrompt(options.system, options.messages)
      const generated = await this.generateTurn(
        transport,
        session,
        complete,
        options,
        connection,
        signal,
        sessionKey,
      )
      yield* this.emitText(generated)
    } catch (error: unknown) {
      if (options.signal?.aborted === true) {
        throw new LlmError('llm-opencode: request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      if (timeout.aborted) {
        throw new LlmError(
          `llm-opencode: server turn did not finish within ${String(connection.requestTimeoutMs)}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      throw error
    }
  }

  /**
   * Complete one turn through transient generation, which renders text
   * without running the server's agent loop. A 404 either names a session
   * the server dropped (recreate once and retry there) or a server without
   * the generate route. The latter fails without running its agent loop.
   */
  private async generateTurn(
    transport: ServerTransport,
    session: { serverID: string },
    text: string,
    options: GenerateOptions,
    connection: OpenCodeServerConnection,
    signal: AbortSignal,
    sessionKey: string | undefined,
  ): Promise<string> {
    const first = await this.generate(transport, session.serverID, text, signal)
    if (first.status === 'ok') return first.text
    const ref = await this.modelRef(options.provider, options.model, effortOf(options))
    const replacement = await this.createSession(connection, transport, ref, signal)
    if (sessionKey !== undefined) {
      this.#sessions.set(sessionKey, {
        serverID: replacement,
        model: options.model,
        providerID: ref.providerID,
        ...ref.variant === undefined ? {} : { variant: ref.variant },
      })
    }
    const second = await this.generate(transport, replacement, text, signal)
    if (second.status === 'missing') {
      throw new LlmError('llm-opencode: server does not support transient generation', 'SERVER')
    }
    return second.text
  }

  private async generate(
    transport: ServerTransport,
    serverID: string,
    text: string,
    signal: AbortSignal,
  ): Promise<{ status: 'ok'; text: string } | { status: 'missing' }> {
    const generated = await this.request(transport, `/api/session/${serverID}/generate`, {
      method: 'POST',
      body: { prompt: text },
      signal,
    })
    if (generated.status === 404) return { status: 'missing' }
    if (generated.status !== 200) throw statusError(generated.status, errorMessage(generated.body), transport.url)
    const out = generatedText(generated.body)
    if (out === undefined || out.length === 0) {
      throw new LlmError('llm-opencode: server generated no text', 'EMPTY_RESPONSE')
    }
    return { status: 'ok', text: out }
  }

  private async modelRef(
    provider: string,
    model: string,
    effort: string | undefined,
  ): Promise<ServerModelRef> {
    if (this.#models.get(provider) === undefined) await this.listModels(provider)
    const entry = this.#models.get(provider)?.find(candidate => candidate.id === model)
    const variant = variantFor(effort, entry?.variants ?? [])
    return {
      id: model,
      providerID: entry?.providerID ?? FALLBACK_PROVIDER_ID,
      ...variant === undefined ? {} : { variant },
    }
  }

  private async sessionFor(
    sessionKey: string | undefined,
    options: GenerateOptions,
    connection: OpenCodeServerConnection,
    transport: ServerTransport,
    model: ServerModelRef,
    signal: AbortSignal,
  ): Promise<{ serverID: string; entry: TrackedSession | undefined }> {
    const tracked = sessionKey === undefined ? undefined : this.#sessions.get(sessionKey)
    if (tracked === undefined || tracked.model !== options.model || tracked.variant !== model.variant) {
      const serverID = await this.createSession(connection, transport, model, signal)
      if (sessionKey === undefined) return { serverID, entry: undefined }
      const entry: TrackedSession = {
        serverID,
        model: options.model,
        providerID: model.providerID,
        ...model.variant === undefined ? {} : { variant: model.variant },
      }
      this.#sessions.set(sessionKey, entry)
      return { serverID, entry }
    }
    return { serverID: tracked.serverID, entry: tracked }
  }

  private async createSession(
    connection: OpenCodeServerConnection,
    transport: ServerTransport,
    model: ServerModelRef,
    signal: AbortSignal,
  ): Promise<string> {
    const created = await this.request(transport, '/api/session', {
      method: 'POST',
      body: { model, location: { directory: connection.directory } },
      signal,
    })
    if (created.status !== 200) throw statusError(created.status, errorMessage(created.body), transport.url)
    const id = isRecord(created.body) && isRecord(created.body.data)
      ? created.body.data.id
      : isRecord(created.body)
        ? created.body.id
        : undefined
    if (typeof id !== 'string' || id.length === 0) {
      throw new LlmError('llm-opencode: server created a session without an id', 'SERVER')
    }
    return id
  }

  private * emitText(text: string): Generator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

}

export type { GenerateOptions }
