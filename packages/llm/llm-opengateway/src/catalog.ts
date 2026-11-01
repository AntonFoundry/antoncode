/**
 * Model discovery for OpenGateway (`GET /v1/models`).
 *
 * OpenGateway advertises each model's input modalities, context window,
 * output cap, deprecation status, and the wire protocols it serves. The
 * harness can speak two of those protocols — OpenAI chat-completions and
 * OpenAI Responses — so a model that advertises neither is not listable here.
 * Discovery is unauthenticated; the catalog is a picker surface, never a
 * servability guarantee.
 *
 * @module @deepseek-ai/dsh-llm-opengateway/catalog
 */

/** One OpenGateway model as discovered from the gateway's own catalog. */
export interface OpenGatewayModel {
  /** Wire model id accepted by the gateway. */
  readonly id: string
  /** Selector label; falls back to {@link id} in consumers. */
  readonly name?: string
  /** Known combined request/response context capacity. */
  readonly contextWindow?: number
  /** Per-request output cap the gateway advertises. */
  readonly maxTokens?: number
  /** Input modalities narrowed to the harness vocabulary. */
  readonly inputModalities: readonly ('text' | 'image')[]
  /** Wire protocol; absent means the chat-completions default. */
  readonly protocol?: 'responses'
}

interface WireModel {
  id?: unknown
  status?: unknown
  modalities?: { input?: unknown }
  endpoints?: unknown
  context_window?: unknown
  max_output_tokens?: unknown
}

/** The gateway's wire-protocol names the harness can serve, in preference order. */
const CHAT_PROTOCOL = 'chat_completions'
const RESPONSES_PROTOCOL = 'responses'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Chat requires text input; an unknown or text-free modality list is not listable. */
function wireModalities(raw: WireModel): readonly ('text' | 'image')[] | undefined {
  const input = raw.modalities?.input
  if (!Array.isArray(input)) return undefined
  const modalities = input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
  return modalities.includes('text') ? modalities : undefined
}

/**
 * Extract the listable models from a parsed `/models` payload.
 *
 * Deprecated models are dropped: the gateway keeps them in the catalog after
 * retirement, and a picker entry that always fails is noise. A model that
 * advertises only the Anthropic Messages protocol stays out too — this
 * adapter has no translator for it, and listing it would produce a failed
 * request instead of an honest absence.
 * @param payload - the parsed `GET /models` document.
 * @returns the listable models keyed by id.
 */
export function parseModels(payload: unknown): Map<string, OpenGatewayModel> {
  if (!isRecord(payload)) throw new Error('llm-opengateway: catalog payload is not an object')
  const data = payload.data
  if (!Array.isArray(data)) throw new Error('llm-opengateway: catalog payload has no data array')

  const models = new Map<string, OpenGatewayModel>()
  for (const value of data) {
    if (!isRecord(value)) continue
    const raw = value as WireModel
    if (typeof raw.id !== 'string' || raw.id.length === 0) continue
    if (raw.status === 'deprecated') continue
    const modalities = wireModalities(raw)
    if (modalities === undefined) continue
    const endpoints = Array.isArray(raw.endpoints)
      ? raw.endpoints.filter((entry): entry is string => typeof entry === 'string')
      : []
    const protocol = endpoints.includes(CHAT_PROTOCOL)
      ? undefined
      : endpoints.includes(RESPONSES_PROTOCOL) ? 'responses' as const : undefined
    if (!endpoints.includes(CHAT_PROTOCOL) && protocol === undefined) continue
    const contextWindow = positiveInteger(raw.context_window)
    const maxTokens = positiveInteger(raw.max_output_tokens)
    models.set(raw.id, {
      id: raw.id,
      inputModalities: modalities,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(protocol === undefined ? {} : { protocol }),
    })
  }
  return models
}

/** One cached catalog snapshot. */
interface CacheEntry {
  readonly at: number
  readonly models: ReadonlyMap<string, OpenGatewayModel>
}

/**
 * Fetch-and-cache client for one OpenGateway endpoint. One instance serves
 * every route of the plugin; the plugin refreshes the snapshot eagerly at
 * mount and on the configured interval, and a failed refresh keeps serving
 * the previous snapshot so a gateway outage never empties a working picker.
 */
export class OpenGatewayCatalog {
  readonly #refreshMs: number
  readonly #cache = new Map<string, CacheEntry>()

  /**
   * @param refreshMs - how long one fetched snapshot serves before the next read refetches.
   */
  constructor(refreshMs: number) {
    this.#refreshMs = refreshMs
  }

  /**
   * The gateway's listable models, fetching or refreshing as needed.
   * @param baseURL - endpoint base the `models` path resolves against.
   * @param onError - receives refresh failures when a stale snapshot serves.
   * @returns the current snapshot, refreshed on cadence.
   * @throws only when no snapshot exists and the fetch failed; the adapter
   * turns that case into an empty picker.
   */
  async models(baseURL: string, onError?: (error: unknown) => void): Promise<ReadonlyMap<string, OpenGatewayModel>> {
    const cached = this.#cache.get(baseURL)
    if (cached !== undefined && Date.now() - cached.at < this.#refreshMs) return cached.models
    try {
      const models = await this.#fetch(baseURL)
      this.#cache.set(baseURL, { at: Date.now(), models })
      return models
    } catch (error) {
      if (cached !== undefined) {
        onError?.(error)
        return cached.models
      }
      throw error
    }
  }

  /**
   * The last successfully fetched snapshot without triggering a refresh.
   * @param baseURL - endpoint base the snapshot was fetched from.
   * @returns the cached models, or `undefined` before the first fetch.
   */
  peek(baseURL: string): ReadonlyMap<string, OpenGatewayModel> | undefined {
    return this.#cache.get(baseURL)?.models
  }

  /**
   * The cached wire protocol of one model id without triggering a refresh.
   * @param baseURL - endpoint base the snapshot was fetched from.
   * @param model - the wire model id.
   * @returns `responses` for a Responses-only model, `undefined` otherwise.
   */
  peekProtocol(baseURL: string, model: string): 'responses' | undefined {
    return this.#cache.get(baseURL)?.models.get(model)?.protocol
  }

  /**
   * Fetch now and replace the cached snapshot regardless of its age; a failed
   * fetch keeps the previous snapshot and reports through `onError`.
   * @param baseURL - endpoint base the `models` path resolves against.
   * @param onError - receives the fetch failure when a stale snapshot serves.
   */
  async refresh(baseURL: string, onError?: (error: unknown) => void): Promise<void> {
    try {
      const models = await this.#fetch(baseURL)
      this.#cache.set(baseURL, { at: Date.now(), models })
    } catch (error) {
      onError?.(error)
    }
  }

  async #fetch(baseURL: string): Promise<Map<string, OpenGatewayModel>> {
    const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
    const url = new URL('models', base)
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'deepseek-harness/llm-opengateway', Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(`llm-opengateway: model discovery at ${url.href} failed with ${response.status}`)
    }
    return parseModels(await response.json() as unknown)
  }
}
