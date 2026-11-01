/**
 * Free-model discovery from the models.dev provider catalog.
 *
 * The catalog is the same source OpenCode itself reads (`GET /api.json`,
 * bundled as a build-time snapshot in opencode): one JSON object mapping a
 * provider id to its advertised models, each carrying per-token `cost`
 * metadata, input modalities, a context limit, and an optional deprecation
 * status. A model counts as free exactly when its declared input and output
 * costs are both zero — a missing cost block does not qualify — and
 * non-chat entries (no text modality) never qualify.
 *
 * @module dsh-llm-models-dev/catalog
 */

/** One free chat model as discovered from the catalog. */
export interface CatalogModel {
  /** Model id accepted by the provider's gateway (the catalog's model key). */
  readonly id: string
  /** Selector label; falls back to {@link id} in consumers. */
  readonly name?: string
  /** Optional user-facing distinction from otherwise similar models. */
  readonly description?: string
  /** Whether the catalog marks the model as reasoning-capable. */
  readonly reasoning: boolean
  /** Exact effort values advertised by the catalog, when available. */
  readonly reasoningEfforts: readonly string[]
  /** Input modalities the catalog advertises, narrowed to the harness vocabulary. */
  readonly inputModalities: readonly ('text' | 'image')[]
  /** Positive combined request/response context capacity when advertised. */
  readonly contextWindow?: number
  /**
   * The wire protocol the gateway serves this model through. `responses`
   * when the catalog declares the OpenAI Responses provider
   * (`provider.npm: "@ai-sdk/openai"`) — OpenCode Zen's Muse Spark family
   * rejects chat-completions for these models with a bare 500 — and the
   * field's absence means chat-completions.
   */
  readonly protocol?: 'responses'
}

interface WireCost {
  input?: unknown
  output?: unknown
}

interface WireModel {
  name?: unknown
  description?: unknown
  status?: unknown
  reasoning?: unknown
  reasoning_options?: unknown
  cost?: WireCost
  modalities?: { input?: unknown }
  limit?: { context?: unknown }
  provider?: { npm?: unknown }
}

/** The catalog marker of the OpenAI Responses wire protocol for one model. */
const RESPONSES_PROVIDER_NPM = '@ai-sdk/openai'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * OpenCode's anonymous provider keeps models whose input cost is zero; other
 * catalogs require explicit zero input and output costs. A missing cost
 * never qualifies. OpenRouter publishes costless entries that are not free
 * chat models, and treating absent costs as zero put them in the picker.
 */
function isFreeModel(model: WireModel, provider: string): boolean {
  if (provider === 'opencode') return model.cost?.input === 0
  return model.cost?.input === 0 && model.cost.output === 0
}

/** Narrow catalog modalities to the harness vocabulary; chat requires text. */
function wireModalities(model: WireModel): readonly ('text' | 'image')[] | undefined {
  const input = model.modalities?.input
  if (!Array.isArray(input)) return undefined
  const mods = input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
  return mods.includes('text') ? mods : undefined
}

const WIRE_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function wireReasoningEfforts(model: WireModel): string[] {
  if (!Array.isArray(model.reasoning_options)) return []
  const levels: string[] = []
  for (const option of model.reasoning_options) {
    if (!isRecord(option) || option.type !== 'effort' || !Array.isArray(option.values)) continue
    for (const value of option.values) {
      if (typeof value === 'string' && WIRE_EFFORTS.has(value) && !levels.includes(value)) levels.push(value)
    }
  }
  return levels
}

/**
 * Extract one provider's free chat models from a parsed models.dev payload.
 *
 * Router meta-routes (ids under the provider's own namespace, such as
 * openrouter's `openrouter/auto` or `openrouter/free`) are excluded: they
 * delegate to other models rather than serve one themselves. Deprecated
 * free entries stay listed — OpenCode's picker keeps them too, and this
 * listing is the picker-parity surface, not a servability guarantee; a
 * retired model fails at request time like any other provider-side outage.
 *
 * @param payload - the parsed `/api.json` document.
 * @param provider - the catalog provider id to extract, e.g. `opencode`.
 * @returns the qualifying models keyed by id, or `undefined` when the
 * provider is absent from the catalog.
 */
export function parseFreeModels(payload: unknown, provider: string): Map<string, CatalogModel> | undefined {
  if (!isRecord(payload)) throw new Error('llm-models-dev: catalog payload is not an object')
  const entry = payload[provider]
  if (entry === undefined) return undefined
  const rawModels = isRecord(entry) && isRecord(entry.models) ? entry.models : null
  if (rawModels === null) throw new Error(`llm-models-dev: catalog provider "${provider}" has no model map`)

  const models = new Map<string, CatalogModel>()
  for (const [id, raw] of Object.entries(rawModels)) {
    if (typeof id !== 'string' || id.length === 0 || !isRecord(raw)) continue
    const model = raw as WireModel
    if (!isFreeModel(model, provider)) continue
    if (id.startsWith(`${provider}/`)) continue
    const modalities = wireModalities(model)
    if (modalities === undefined) continue
    const contextLimit = model.limit?.context
    const contextWindow = typeof contextLimit === 'number' && Number.isInteger(contextLimit) && contextLimit > 0
      ? contextLimit
      : undefined
    models.set(id, {
      id,
      ...(typeof model.name === 'string' && model.name.length > 0 ? { name: model.name } : {}),
      ...(typeof model.description === 'string' && model.description.length > 0
        ? { description: model.description }
        : {}),
      reasoning: model.reasoning === true,
      reasoningEfforts: wireReasoningEfforts(model),
      inputModalities: modalities,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...(model.provider?.npm === RESPONSES_PROVIDER_NPM ? { protocol: 'responses' as const } : {}),
    })
  }
  return models
}

/**
 * Extract the wire protocol of every model in one provider's snapshot, free
 * or paid. The free-model map ({@link parseFreeModels}) is the picker
 * surface and drops paid entries, but request routing must still know a paid
 * model's protocol: OpenCode Zen's Muse Spark family rejects
 * chat-completions with a bare 500 and completes on `/responses`, whether
 * the caller uses the `-free` or the paid model id. Presence in the returned
 * map means `responses`; absence means chat-completions. An absent provider
 * yields an empty map rather than `undefined`: routing treats an unknown
 * model as chat-completions either way, so unlike the picker surface there
 * is no absent-versus-empty distinction to preserve.
 *
 * @param payload - the parsed `/api.json` document.
 * @param provider - the catalog provider id, e.g. `opencode`.
 * @returns each Responses-protocol model id.
 */
export function parseModelProtocols(payload: unknown, provider: string): Map<string, 'responses'> {
  if (!isRecord(payload)) throw new Error('llm-models-dev: catalog payload is not an object')
  const entry = payload[provider]
  if (entry === undefined) return new Map()
  const rawModels = isRecord(entry) && isRecord(entry.models) ? entry.models : null
  if (rawModels === null) throw new Error(`llm-models-dev: catalog provider "${provider}" has no model map`)

  const protocols = new Map<string, 'responses'>()
  for (const [id, raw] of Object.entries(rawModels)) {
    if (typeof id !== 'string' || id.length === 0 || !isRecord(raw)) continue
    const model = raw as WireModel
    if (model.provider?.npm === RESPONSES_PROVIDER_NPM) protocols.set(id, 'responses')
  }
  return protocols
}

/** One cached provider snapshot: the free-model picker map plus every model's wire protocol. */
interface CacheEntry {
  readonly at: number
  readonly models: ReadonlyMap<string, CatalogModel>
  readonly protocols: ReadonlyMap<string, 'responses'>
}

/**
 * Fetch-and-cache client for the free tiers of models.dev providers. One
 * instance serves every route of the plugin; the plugin refreshes each entry
 * eagerly at mount and re-fetches on the configured interval through
 * {@link ModelsDevCatalog.refresh}, and a failed refresh keeps serving the
 * previous snapshot, so a catalog outage never empties a working picker.
 *
 * Each entry pairs the free-model picker map with the wire protocol of every
 * catalog model: paid ids never enter the picker, but request routing still
 * needs their protocol (see {@link parseModelProtocols}).
 */
export class ModelsDevCatalog {
  readonly #catalogURL: string
  readonly #refreshMs: number
  readonly #cache = new Map<string, CacheEntry>()

  constructor(catalogURL: string, refreshMs: number) {
    this.#catalogURL = catalogURL
    this.#refreshMs = refreshMs
  }

  /**
   * The provider's current free models, fetching or refreshing as needed.
   * @param provider - the catalog provider id.
   * @param onError - receives refresh failures when a stale snapshot serves.
   * @throws only when no snapshot exists at all and the fetch failed; the
   * adapter converts that case into an empty picker.
   */
  async freeModels(provider: string, onError?: (error: unknown) => void): Promise<ReadonlyMap<string, CatalogModel>> {
    const cached = this.#cache.get(provider)
    if (cached !== undefined && Date.now() - cached.at < this.#refreshMs) return cached.models
    try {
      const snapshot = await this.#fetch(provider)
      this.#cache.set(provider, { at: Date.now(), ...snapshot })
      return snapshot.models
    } catch (error) {
      if (cached !== undefined) {
        onError?.(error)
        return cached.models
      }
      throw error
    }
  }

  /**
   * The last successfully fetched snapshot without triggering a refresh, for
   * synchronous enrichment of already-discovered models.
   */
  peekCached(provider: string): ReadonlyMap<string, CatalogModel> | undefined {
    return this.#cache.get(provider)?.models
  }

  /**
   * The cached wire protocol of one model id without triggering a refresh,
   * for synchronous request-time routing. `responses` when the catalog marks
   * the model for the OpenAI Responses protocol; `undefined` means the
   * chat-completions default (or no snapshot has been fetched yet).
   * @param provider - the catalog provider id.
   * @param model - the wire model id.
   */
  peekProtocol(provider: string, model: string): 'responses' | undefined {
    return this.#cache.get(provider)?.protocols.get(model)
  }

  /**
   * Fetch now and replace the cached snapshot regardless of its age; a failed
   * fetch keeps the previous snapshot and reports through `onError` instead of
   * rejecting. The mount-time and scheduled refreshes call this so a restart
   * and every interval tick converge on the newest catalog without waiting
   * for a consumer query.
   * @param provider - the catalog provider id.
   * @param onError - receives the fetch failure when a stale snapshot serves.
   */
  async refresh(provider: string, onError?: (error: unknown) => void): Promise<void> {
    try {
      const snapshot = await this.#fetch(provider)
      this.#cache.set(provider, { at: Date.now(), ...snapshot })
    } catch (error) {
      onError?.(error)
    }
  }

  async #fetch(provider: string): Promise<{ models: Map<string, CatalogModel>; protocols: Map<string, 'responses'> }> {
    const base = this.#catalogURL.endsWith('/') ? this.#catalogURL : `${this.#catalogURL}/`
    const response = await fetch(new URL('api.json', base), {
      method: 'GET',
      headers: { 'User-Agent': 'deepseek-harness/llm-models-dev', Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(`llm-models-dev: catalog fetch from ${base}api.json failed with ${response.status}`)
    }
    const document: unknown = await response.json() as unknown
    const models = parseFreeModels(document, provider)
    if (models === undefined) {
      throw new Error(`llm-models-dev: catalog provider "${provider}" is not published on ${base}`)
    }
    return { models, protocols: parseModelProtocols(document, provider) }
  }
}
