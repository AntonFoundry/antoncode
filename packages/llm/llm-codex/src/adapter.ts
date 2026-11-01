/**
 * `CodexAdapter`: fetch + SSE against the OpenAI Codex backend
 * (`https://chatgpt.com/backend-api/codex/responses`), emitting harness
 * StreamChunks. Authentication is the Codex subscription OAuth session —
 * access token resolved through the shared `~/.codex/auth.json` login (with
 * silent refresh) — never an API key. The adapter is transport-only:
 * connection facts arrive through a thunk resolved once per operation and the
 * bearer token through a per-request resolver, so the registering plugin owns
 * validation, layering, and credential policy.
 *
 * @module dsh-llm-codex/adapter
 */

import { attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { serializeRequest } from './serialize.ts'
import type { RequestDefaults } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError } from './types.ts'

/** One optional model entry advertised by the Codex adapter. */
export interface CodexCatalogModel {
  /** Wire model id accepted by the Codex backend. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's {@link CodexConnectionOptions.maxTokens}. */
  maxTokens?: number
  /** Exact reasoning choices accepted by this model; omission uses the adapter's legacy Codex set. */
  reasoningEfforts?: CodexReasoningEffort[]
  /** API-advertised default reasoning choice. */
  defaultReasoningEffort?: CodexReasoningEffort
  /** API-advertised descriptions keyed by exact reasoning choice. */
  reasoningEffortDescriptions?: Partial<Record<CodexReasoningEffort, string>>
}

/** Codex effort ids exposed by model metadata and the Responses request. */
export type CodexReasoningEffort = 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation.
 */
export interface CodexConnectionOptions {
  /** Endpoint base; `/responses` is appended. */
  baseURL: string
  /** Codex home directory holding the shared `auth.json` login. */
  codexHome: string
  /** Resolved selector label for this route; a display fact, never a transport one. */
  displayName: string
  /** Request defaults applied to every call (reasoning effort). */
  defaults: RequestDefaults
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly CodexCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link CodexAdapter}: the operation-local resolution hooks the plugin owns. */
export interface CodexAdapterOptions {
  /**
   * Current validated connection facts for one provider route; called once
   * per operation with the route the operation targets.
   */
  options: (provider: string) => CodexConnectionOptions
  /**
   * Resolve the Codex OAuth session for one request (access token + account
   * id), refreshing and persisting the shared login as needed. Throws
   * `LlmError` `MISSING_CREDENTIAL`/`AUTH` when no usable login exists.
   */
  resolveAuth: (
    connection: CodexConnectionOptions,
    forceRefresh?: boolean,
  ) => Promise<{ accessToken: string; accountId?: string; residency?: string }>
  /** Resolve the harness-home anonymous id used as the Codex ephemeral user id. */
  resolveUserId: () => AnonymousUserId
  /** Durable attachment resolver used to replay image-bearing history. */
  resolveAttachments: () => AttachmentStore | undefined
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity (gpt-5.x-codex class). */
export const DEFAULT_CONTEXT_WINDOW = 400_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 32_768
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const LOW_REASONING_EFFORT = ReasoningEffortId('low')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
/** Legacy fallback for catalogs that predate per-model effort metadata. */
const REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
  { id: LOW_REASONING_EFFORT, name: 'Low' },
  { id: HIGH_REASONING_EFFORT, name: 'High' },
] as const

/** Return the catalog's exact effort set or the adapter's legacy Codex set. */
function modelReasoningEfforts(configured: CodexCatalogModel | undefined) {
  if (configured?.reasoningEfforts !== undefined) {
    return configured.reasoningEfforts.map(id => ({
      id: ReasoningEffortId(id),
      name: id === 'off' ? 'Off'
        : id === 'none' ? 'None'
          : id === 'xhigh' ? 'Extra high'
            : id === 'max' ? 'More reasoning…'
              : id === 'ultra' ? 'Ultra'
                : id.slice(0, 1).toUpperCase() + id.slice(1),
      ...configured.reasoningEffortDescriptions?.[id] === undefined
        ? {}
        : { description: configured.reasoningEffortDescriptions[id] },
    }))
  }
  return REASONING_EFFORTS
}

/** Do not send a configured default that this model's picker cannot select. */
function requestDefaults(
  connection: CodexConnectionOptions,
  model: string,
  configured: CodexCatalogModel | undefined,
): RequestDefaults {
  const effort = connection.defaults.reasoningEffort
  if (effort !== undefined
    && !modelReasoningEfforts(configured ?? connection.models.find(entry => entry.id === model))
      .some(choice => choice.id === ReasoningEffortId(effort))) {
    return { ...connection.defaults, reasoningEffort: undefined }
  }
  return connection.defaults
}

function modelInfo(provider: string, model: CodexCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: ['text', 'image'],
  }
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available (both `error` and `detail` shapes).
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError): string {
  if (status === 401 || status === 403) return 'AUTH'
  const body = error?.error
  const detail = [body?.code, body?.type, body?.message, error?.detail].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

interface ModelsCacheEntry {
  slug?: unknown
  display_name?: unknown
  supported_in_api?: unknown
  default_reasoning_level?: unknown
  supported_reasoning_levels?: { effort?: unknown; description?: unknown }[]
  /** Codex CLI's combined request/response capacity for this model. */
  context_window?: unknown
}

interface ModelsCacheShape { models?: ModelsCacheEntry[] }

function isReasoningLevel(value: unknown): value is { effort?: unknown; description?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
])

function cacheEffort(value: unknown): CodexReasoningEffort | undefined {
  return typeof value === 'string' && CODEX_REASONING_EFFORTS.has(value as CodexReasoningEffort)
    ? value as CodexReasoningEffort
    : undefined
}

/**
 * Discover the subscription's live model list from the Codex CLI's own
 * `models_cache.json` (the same list the CLI syncs per account). Absent or
 * unreadable cache falls back to the configured catalog.
 */
async function discoverModels(codexHome: string): Promise<CodexCatalogModel[]> {
  const cachePaths = [...new Set([
    join(codexHome, 'models_cache.json'),
    join(homedir(), '.codex', 'models_cache.json'),
  ])]
  for (const cachePath of cachePaths) {
    let parsed: ModelsCacheShape
    try {
      parsed = JSON.parse(await readFile(cachePath, 'utf8')) as ModelsCacheShape
    } catch {
      continue
    }
    const models: CodexCatalogModel[] = []
    for (const entry of parsed.models ?? []) {
      if (entry.supported_in_api === false) continue
      const id = entry.slug
      if (typeof id !== 'string' || id.length === 0) continue
      const levels = Array.isArray(entry.supported_reasoning_levels)
        ? entry.supported_reasoning_levels.filter(isReasoningLevel)
        : undefined
      const reasoningEfforts = levels
        ?.map(level => cacheEffort(level.effort))
        .filter((effort): effort is CodexReasoningEffort => effort !== undefined)
      const descriptions = Object.fromEntries(
        (levels ?? []).flatMap((level) => {
          const effort = cacheEffort(level.effort)
          return effort !== undefined && typeof level.description === 'string' && level.description.length > 0
            ? [[effort, level.description]]
            : []
        }),
      ) as Partial<Record<CodexReasoningEffort, string>>
      const defaultReasoningEffort = cacheEffort(entry.default_reasoning_level)
      models.push({
        id,
        ...typeof entry.display_name === 'string' ? { name: entry.display_name } : {},
        ...(typeof entry.context_window === 'number' && Number.isSafeInteger(entry.context_window) && entry.context_window > 0
          ? { contextWindow: entry.context_window }
          : {}),
        ...(reasoningEfforts === undefined ? {} : { reasoningEfforts: [...new Set(reasoningEfforts)] }),
        ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
        ...Object.keys(descriptions).length === 0 ? {} : { reasoningEffortDescriptions: descriptions },
      })
    }
    if (models.length > 0) return models
  }
  return []
}

/** Keep configured model facts, enriching missing capacity and reasoning data from Codex's live catalog cache. */
function mergeModels(catalog: readonly CodexCatalogModel[], discovered: readonly CodexCatalogModel[]): CodexCatalogModel[] {
  const known = new Set(catalog.map(model => model.id))
  const byId = new Map(discovered.map(model => [model.id, model]))
  return [
    ...catalog.map((model) => {
      const live = byId.get(model.id)
      if (live === undefined) return model
      return {
        ...live,
        ...model,
        ...(model.contextWindow === undefined && live.contextWindow !== undefined
          ? { contextWindow: live.contextWindow }
          : {}),
        ...(model.reasoningEfforts === undefined && live.reasoningEfforts !== undefined
          ? { reasoningEfforts: live.reasoningEfforts }
          : {}),
        ...(model.defaultReasoningEffort === undefined && live.defaultReasoningEffort !== undefined
          ? { defaultReasoningEffort: live.defaultReasoningEffort }
          : {}),
        ...(model.reasoningEffortDescriptions === undefined && live.reasoningEffortDescriptions !== undefined
          ? { reasoningEffortDescriptions: live.reasoningEffortDescriptions }
          : {}),
      }
    }),
    ...discovered.filter(model => !known.has(model.id)),
  ]
}

/**
 * One adapter instance serves every model name it was registered under (the
 * harness model name IS the wire model name) on the `codex` provider route.
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class CodexAdapter extends LlmAdapter {
  constructor(private readonly config: CodexAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const { displayName } = this.config.options(provider)
    return {
      id: provider,
      name: displayName,
    }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.config.options(provider).retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const connection = this.config.options(provider)
    const discovered = await discoverModels(connection.codexHome)
    return mergeModels(connection.models, discovered).map(model => modelInfo(provider, model))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options(provider)
    const discovered = await discoverModels(connection.codexHome)
    const configured = mergeModels(connection.models, discovered).find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow
      ?? connection.defaultContextWindow
    const efforts = modelReasoningEfforts(configured)
    const configuredDefault = connection.defaults.reasoningEffort
      ?? configured?.defaultReasoningEffort
      ?? (configured?.reasoningEfforts === undefined ? 'high' : undefined)
    const defaultEffort = configuredDefault === undefined ? undefined : ReasoningEffortId(configuredDefault)
    const supportedDefaultEffort = efforts.some(effort => effort.id === defaultEffort)
      ? defaultEffort
      : undefined
    return {
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text', 'image'] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      ...(efforts.length === 0 ? {} : {
        reasoning: {
          efforts,
          ...(supportedDefaultEffort === undefined ? {} : { defaultEffort: supportedDefaultEffort }),
        },
      }),
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    const connection = this.config.options(options.provider)
    const discovered = await discoverModels(connection.codexHome)
    const modelInfo = mergeModels(connection.models, discovered).find(entry => entry.id === options.model)
    const auth = await this.config.resolveAuth(connection)
    const userId = this.config.resolveUserId()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      modelInfo,
      auth.accessToken,
      auth.accountId,
      auth.residency,
      userId,
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
          `OpenAI Codex stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('OpenAI Codex request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`OpenAI Codex stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('OpenAI Codex stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: CodexConnectionOptions,
    modelInfo: CodexCatalogModel | undefined,
    accessToken: string,
    accountId: string | undefined,
    residency: string | undefined,
    userId: AnonymousUserId,
    onComment: () => void,
    retriedAfterAuthRefresh = false,
  ): AsyncIterable<StreamChunk> {
    const body = await serializeRequest(
      options,
      requestDefaults(connection, options.model, modelInfo),
      this.config.resolveAttachments(),
    )
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = {
      'authorization': `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'originator': 'opencode',
      'openai-ephemeral-user-id': String(userId),
      ...attributionHeaders(),
      ...options.sessionId !== undefined
        ? { 'session-id': String(options.sessionId) }
        : {},
      'x-deepseek-harness-user-id': String(userId),
      ...options.sessionId !== undefined
        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
        : {},
      ...options.purpose === 'compaction'
        ? { 'x-deepseek-harness-compact': '1' }
        : {},
    }
    if (accountId !== undefined && accountId.length > 0) headers['ChatGPT-Account-Id'] = accountId
    if (residency !== undefined) headers['x-openai-internal-codex-residency'] = residency

    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/responses`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `OpenAI Codex request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `OpenAI Codex API error (HTTP ${response.status})`
      let providerError: WireError | undefined
      try {
        const parsed = await response.json() as WireError
        providerError = parsed
        if (parsed.error?.message) message = parsed.error.message
        else if (parsed.detail) message = parsed.detail
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the
        // failure, so malformed gateway JSON must not mask it.
      }
      if (!retriedAfterAuthRefresh && response.status === 401 && providerError?.error?.code === 'token_expired') {
        const refreshed = await this.config.resolveAuth(connection, true)
        yield* this.request(
          options,
          signal,
          connection,
          modelInfo,
          refreshed.accessToken,
          refreshed.accountId,
          refreshed.residency,
          userId,
          onComment,
          true,
        )
        return
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('OpenAI Codex returned no response body', 'EMPTY_RESPONSE')
    }
    const responseBody = response.body

    // SSE data payloads → parsed events → harness StreamChunks. Malformed
    // JSON payloads abort with MALFORMED_RESPONSE.
    async function* events(): AsyncGenerator<import('./types.ts').WireEvent> {
      for await (const payload of parseSse(responseBody, onComment)) {
        let event: import('./types.ts').WireEvent
        try {
          event = JSON.parse(payload) as import('./types.ts').WireEvent
        } catch {
          throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
        }
        yield event
      }
    }

    yield* translate(events())
  }
}
