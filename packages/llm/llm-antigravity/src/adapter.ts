/**
 * `AntigravityAdapter`: fetch + SSE against the Google Antigravity gateway,
 * emitting harness StreamChunks. Authentication is Google OAuth — an access
 * token resolved through the shared Antigravity account store (with silent
 * refresh) — never an API key. The adapter is transport-only: connection
 * facts arrive through a thunk resolved once per operation and the access
 * token through a per-request resolver, so the registering plugin owns
 * validation, layering, and credential policy.
 *
 * @module @deepseek-ai/dsh-llm-antigravity/adapter
 */

import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { parseSse } from './sse.ts'
import {
  initialSnapshotState,
  mapFinishReason,
  retryAfterSeconds,
  retryDelayMs,
  translateRequest,
  translateSnapshot,
  translateUsage,
} from './translate.ts'
import type { AntigravitySseEvent } from './translate.ts'
import { readAccounts } from './auth.ts'
import { ANTIGRAVITY_ENDPOINT_DAILY, ANTIGRAVITY_ENDPOINT_PROD } from './auth.ts'
import { PROVIDER } from './invariant.ts'

/** One optional model entry advertised by the Antigravity adapter. */
export interface AntigravityCatalogModel {
  /** Wire model id accepted by the Antigravity gateway. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity. */
  contextWindow?: number
  /** Per-request output cap for this model. */
  maxTokens?: number
}

/** Default advisory catalog matching the Antigravity gateway. */
export const DEFAULT_MODELS: readonly AntigravityCatalogModel[] = [
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', contextWindow: 1_048_576, maxTokens: 65_535 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', contextWindow: 200_000, maxTokens: 64_000 },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', contextWindow: 200_000, maxTokens: 64_000 },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', contextWindow: 200_000, maxTokens: 32_768 },
]

const MEDIUM_EFFORT = ReasoningEffortId('medium')
const FAST_EFFORT = ReasoningEffortId('fast')
const LOW_EFFORT = ReasoningEffortId('low')
const HIGH_EFFORT = ReasoningEffortId('high')

const FLASH_EFFORTS = [
  { id: HIGH_EFFORT, name: 'High' },
  { id: MEDIUM_EFFORT, name: 'Medium' },
  { id: LOW_EFFORT, name: 'Low' },
  { id: FAST_EFFORT, name: 'Fast' },
] as const

const PRO_EFFORTS = [
  { id: HIGH_EFFORT, name: 'High' },
  { id: MEDIUM_EFFORT, name: 'Medium' },
  { id: LOW_EFFORT, name: 'Low' },
] as const

const CLAUDE_EFFORTS = [
  { id: HIGH_EFFORT, name: 'High' },
  { id: LOW_EFFORT, name: 'Low' },
] as const

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation.
 */
export interface AntigravityConnectionOptions {
  /** Gateway base URL; `/v1internal:streamGenerateContent?alt=sse` is appended. */
  baseURL: string
  /** Path to the shared Antigravity accounts file; empty means the default. */
  accountsPath: string
  /** Resolved selector label for this route. */
  displayName: string
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers. */
  models: readonly AntigravityCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link AntigravityAdapter}. */
export interface AntigravityAdapterOptions {
  /** Current validated connection facts for one provider route. */
  options: (provider: string) => AntigravityConnectionOptions
  /** Resolve an access token (refreshing the shared account store as needed). */
  resolveAuth: () => Promise<{ accessToken: string; projectId?: string }>
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 64_000
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

function modelInfo(provider: string, model: AntigravityCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: ['text', 'image'],
  }
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-cloudaicompanion-trace-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an HTTP status + Antigravity error body to a stable LlmError code.
 */
export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 404) return 'MODEL_NOT_FOUND'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * One adapter instance serves the models it was registered with on the
 * `antigravity` provider route. Caller aborts map to `ABORTED`; the configured
 * per-read idle watchdog maps to `TIMEOUT`.
 */
export class AntigravityAdapter extends LlmAdapter {
  constructor(private readonly config: AntigravityAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const { displayName, accountsPath } = this.config.options(provider)
    return {
      id: provider,
      name: displayName,
      // A stored login is the OAuth counterpart of the API-key dots shown for
      // other providers; it is not a remote health probe.
      authConfigured: readAccounts(accountsPath).length > 0,
    }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.config.options(provider).retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const connection = this.config.options(provider)
    return connection.models.map(model => modelInfo(provider, model))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options(provider)
    const configured = connection.models.find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow
    const isFlash = model.includes('flash')
    const isPro = model.includes('pro')
    const isClaude = model.includes('claude')
    const reasoning = isFlash
      ? { efforts: FLASH_EFFORTS, defaultEffort: MEDIUM_EFFORT }
      : isPro
        ? { efforts: PRO_EFFORTS, defaultEffort: LOW_EFFORT }
        : isClaude
          ? { efforts: CLAUDE_EFFORTS, defaultEffort: HIGH_EFFORT }
          : undefined
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text', 'image'] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      ...reasoning === undefined ? {} : { reasoning },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options(options.provider)
    const auth = await this.config.resolveAuth()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      auth.accessToken,
      auth.projectId,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Antigravity stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Antigravity request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Antigravity stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Antigravity stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: AntigravityConnectionOptions,
    accessToken: string,
    projectId: string | undefined,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const modelId = options.model
    const wireRequestId = randomUUID()
    const body = translateRequest(options, projectId ?? '', wireRequestId, modelId)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'Client-Metadata': JSON.stringify({ ideType: 'ANTIGRAVITY', platform: 'MACOS', pluginType: 'GEMINI' }),
      ...attributionHeaders(),
      ...options.sessionId !== undefined
        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
        : {},
      // The gateway validates the Antigravity IDE's Electron/Chrome user
      // agent (verified live; the Go-style `antigravity/x.y` agent and any
      // merged duplicate are rejected). This deliberately replaces the
      // attribution user-agent — same lowercase key, single value — because a
      // case-mismatched second `User-Agent` corrupts the header into a
      // comma-joined pair the gateway refuses.
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36',
    }

    let response: Response
    let endpointBase = connection.baseURL
    try {
      response = await fetch(`${endpointBase}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `Antigravity request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    // The prod gateway rate-limits per client identity while the daily
    // sandbox gateway keeps an independent quota; a prod 429 fails over to
    // daily once before surfacing the failure (verified live — the IDE does
    // the same failover, which is why it keeps working when prod is exhausted).
    if (response.status === 429 && endpointBase === ANTIGRAVITY_ENDPOINT_PROD && !signal.aborted) {
      endpointBase = ANTIGRAVITY_ENDPOINT_DAILY
      body.requestId = `agent-${randomUUID()}`
      try {
        response = await fetch(`${endpointBase}/v1internal:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        })
      } catch (error: unknown) {
        if (signal.aborted) throw error
        throw new LlmError(
          `Antigravity request to ${connection.baseURL} failed`,
          'TRANSPORT',
          { cause: error },
        )
      }
    }

    if (!response.ok) {
      let message = `Antigravity API error (HTTP ${response.status})`
      let details: unknown[] | undefined
      try {
        const parsed = (await response.json()) as { error?: { message?: string; status?: string; details?: unknown[] } }
        if (parsed.error?.message) message = parsed.error.message
        if (Array.isArray(parsed.error?.details)) details = parsed.error.details
      } catch {
        // The HTTP status still identifies the failure.
      }
      const delay = retryAfterSeconds(response.headers.get('retry-after')) ?? retryDelayMs(details)
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('Antigravity returned no response body', 'EMPTY_RESPONSE')
    }

    // Antigravity SSE is a stream of cumulative snapshots: parse each `data:`
    // line and emit only the growth (text/reasoning deltas + new tool calls),
    // then the terminal usage + finish.
    const state = initialSnapshotState()
    let sawContent = false
    let sawFinish = false
    async function* events(): AsyncGenerator<AntigravitySseEvent> {
      for await (const payload of parseSse(response!.body!, onComment)) {
        let event: AntigravitySseEvent
        try {
          event = JSON.parse(payload) as AntigravitySseEvent
        } catch {
          throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
        }
        yield event
      }
    }
    let sawUsage = false
    let hasToolCall = false
    for await (const event of events()) {
      const candidate = event.response?.candidates?.[0]
      const parts = candidate?.content?.parts
      if (parts !== undefined && parts.length > 0) sawContent = true
      if (parts?.some(part => 'functionCall' in part && part.functionCall) === true) hasToolCall = true
      yield* translateSnapshot(parts, state, 0)
      const usage = translateUsage(event)
      if (usage !== undefined) {
        sawUsage = true
        yield usage
      }
      const reason = candidate?.finishReason
      if (reason !== undefined && reason !== '') {
        if (!sawUsage) {
          // Usage must precede the terminal finish; synthesize zeros when the
          // gateway's final snapshot carried no usageMetadata.
          sawUsage = true
          yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
        }
        sawFinish = true
        yield mapFinishReason(reason, hasToolCall)
      }
    }
    if (!sawFinish) {
      if (!sawUsage) yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield {
        type: 'finish',
        reason: sawContent ? { kind: 'stop' } : { kind: 'error', failure: { message: 'Antigravity stream ended without a finish event', code: 'EMPTY_RESPONSE' } },
      }
    }
  }
}

export { PROVIDER }
