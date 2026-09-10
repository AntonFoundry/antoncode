/**
 * Free-model discovery from the models.dev provider catalog.
 *
 * The catalog is the same source OpenCode itself reads (`GET /api.json`,
 * bundled as a build-time snapshot in opencode): one JSON object mapping a
 * provider id to its advertised models, each carrying per-token `cost`
 * metadata, input modalities, a context limit, and an optional deprecation
 * status. A model counts as free exactly when its input and output costs are
 * both zero — mirroring OpenCode's `cost.input === 0` picker (which keeps
 * deprecated free models listed) — and non-chat entries (no text modality)
 * never qualify.
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

/** Missing cost means zero: the same defaulting opencode's `fromModelsDevModel` applies. */
function wireInput(model: WireModel): number {
  const input = model.cost?.input
  return typeof input === 'number' && Number.isFinite(input) ? input : 0
}

function wireOutput(model: WireModel): number {
  const output = model.cost?.output
  return typeof output === 'number' && Number.isFinite(output) ? output : 0
}

/**
 * The freeness predicate, mirroring OpenCode's picker rule
 * (`provider === "opencode" && (!cost || cost.input === 0)`).
 * OpenCode keeps deprecated free models (e.g. kimi-k2.5-free, glm-4.7-free)
 * listed — 24 of its 31 free models are marked deprecated — so this predicate
 * does NOT filter by status. Deprecated entries are often retired upstream:
 * the gateway no longer advertises them or answers `not supported` /
 * `unavailable` per request. This listing is the picker-parity surface, not a
 * servability guarantee; a retired model fails at request time like any
 * other provider-side outage.
 * It keeps the harness tightened check on output cost as well so a
 * zero-input/paid-output entry never qualifies (no such entry exists
 * today, so the visible set stays identical to OpenCode's input-only rule).
 */
function isFreeModel(model: WireModel): boolean {
  return wireInput(model) === 0 && wireOutput(model) === 0
}

/** Narrow catalog modalities to the harness vocabulary; chat requires text. */
function wireModalities(model: WireModel): readonly ('text' | 'image')[] | undefined {
  const input = model.modalities?.input
  if (!Array.isArray(input)) return undefined
  const mods = input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
  return mods.includes('text') ? mods : undefined
}

/**
 * Extract one provider's free chat models from a parsed models.dev payload.
 *
 * Router meta-routes (ids under the provider's own namespace, such as
 * openrouter's `openrouter/auto` or `openrouter/free`) are excluded: they
 * delegate to other models rather than serve one themselves.
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
    if (!isFreeModel(model)) continue
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
      inputModalities: modalities,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...(model.provider?.npm === RESPONSES_PROVIDER_NPM ? { protocol: 'responses' as const } : {}),
    })
  }
  return models
}

/** Cached snapshot of one provider's free models. */
interface CacheEntry {
  readonly at: number
  readonly models: ReadonlyMap<string, CatalogModel>
}

/**
 * Fetch-and-cache client for the free tiers of models.dev providers. One
 * instance serves every route of the plugin; entries refresh after the
 * configured interval and a failed refresh keeps serving the previous
 * snapshot, so a catalog outage never empties a working picker.
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
      const models = await this.#fetch(provider)
      this.#cache.set(provider, { at: Date.now(), models })
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
   * The last successfully fetched snapshot without triggering a refresh, for
   * synchronous enrichment of already-discovered models.
   */
  peekCached(provider: string): ReadonlyMap<string, CatalogModel> | undefined {
    return this.#cache.get(provider)?.models
  }

  async #fetch(provider: string): Promise<Map<string, CatalogModel>> {
    const base = this.#catalogURL.endsWith('/') ? this.#catalogURL : `${this.#catalogURL}/`
    const response = await fetch(new URL('api.json', base), {
      method: 'GET',
      headers: { 'User-Agent': 'deepseek-harness/llm-models-dev', Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(`llm-models-dev: catalog fetch from ${base}api.json failed with ${response.status}`)
    }
    const models = parseFreeModels(await response.json(), provider)
    if (models === undefined) {
      throw new Error(`llm-models-dev: catalog provider "${provider}" is not published on ${base}`)
    }
    return models
  }
}
