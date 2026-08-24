/**
 * `ModelsDevAdapter`: the free-tier transport for models.dev catalog
 * providers. Streaming is inherited unchanged from {@link OpenAIAdapter} —
 * every route's gateway speaks the OpenAI chat-completions protocol — and
 * only discovery is overridden: instead of a static configured catalog, each
 * query reads the provider's current free tier from models.dev (see
 * {@link ModelsDevCatalog}), and model resolution enriches the inherited
 * facts with the catalog entry's real context window and modalities.
 *
 * @module dsh-llm-models-dev/adapter
 */

import { OpenAIAdapter } from '@deepseek-ai/dsh-llm-openai'
import type { OpenAIAdapterOptions, OpenAIConnectionOptions } from '@deepseek-ai/dsh-llm-openai'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { CatalogModel, ModelsDevCatalog } from './catalog.ts'

/** One resolution's connection facts: the OpenAI facts plus the catalog identity. */
export type ModelsDevConnectionOptions = OpenAIConnectionOptions & {
  /** models.dev provider id whose free tier this route serves. */
  catalogProvider: string
}

/** Constructor options: the OpenAI operation hooks with the catalog-aware option thunk. */
export interface ModelsDevAdapterOptions extends Omit<OpenAIAdapterOptions, 'options'> {
  options: (provider: string) => ModelsDevConnectionOptions
  /** The shared catalog client; one instance serves every route. */
  catalog: ModelsDevCatalog
  /** Receives catalog refresh failures that a stale snapshot absorbed. */
  onCatalogError?: (error: unknown) => void
}

function toModelInfo(provider: string, model: CatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities,
  }
}

export class ModelsDevAdapter extends OpenAIAdapter {
  readonly #options: (provider: string) => ModelsDevConnectionOptions
  readonly #catalog: ModelsDevCatalog
  readonly #onCatalogError: ((error: unknown) => void) | undefined

  constructor(options: ModelsDevAdapterOptions) {
    super(options)
    this.#options = options.options
    this.#catalog = options.catalog
    this.#onCatalogError = options.onCatalogError
  }

  /**
   * The provider's live free tier. An unreachable or empty catalog yields an
   * empty list — the route stays registered and recovers on the next query.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const connection = this.#options(provider)
    let entries: ReadonlyMap<string, CatalogModel>
    try {
      entries = await this.#catalog.freeModels(connection.catalogProvider, this.#onCatalogError)
    } catch {
      return []
    }
    return [...entries.values()].map(model => toModelInfo(provider, model))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    const entry = this.#catalog.peekCached(this.#options(provider).catalogProvider)?.get(model)
    if (entry === undefined) return resolved
    return {
      ...resolved,
      name: entry.name ?? resolved.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      inputModalities: entry.inputModalities,
      // The catalog advertises the gateway's real capacity; the configured
      // default only serves models the snapshot has not seen yet.
      ...(entry.contextWindow === undefined ? {} : { context: { contextWindow: entry.contextWindow } }),
    }
  }
}
