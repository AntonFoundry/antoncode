/**
 * `OpenGatewayAdapter`: the harness LLM transport for OpenGateway.
 *
 * Streaming is inherited unchanged from {@link OpenAIAdapter} — OpenGateway
 * serves the OpenAI chat-completions and Responses protocols — and only
 * discovery is overridden: every query reads the gateway's own `/models`
 * catalog, and model resolution enriches the inherited facts with the
 * catalog entry's context window and output cap. The wire protocol is
 * declared per model, because the gateway serves some models through
 * Responses only.
 *
 * The gateway documents a reasoning-effort vocabulary but its catalog carries
 * no per-model effort metadata, so this route offers its configured ladder on
 * every model and sends the picker's choice verbatim; the gateway maps the
 * label to the selected provider's own control.
 *
 * @module @deepseek-ai/dsh-llm-opengateway/adapter
 */

import { OpenAIAdapter, modelReasoningInfo } from '@deepseek-ai/dsh-llm-openai'
import type { OpenAIAdapterOptions, OpenAIConnectionOptions } from '@deepseek-ai/dsh-llm-openai'
import type { VERBATIM_REASONING_EFFORTS } from '@deepseek-ai/dsh-llm-openai'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { OpenGatewayCatalog, OpenGatewayModel } from './catalog.ts'

/**
 * Reasoning-effort labels OpenGateway documents, taken from the shared wire
 * vocabulary so a configured level always survives serialization. The gateway
 * maps them to the selected provider's controls; which levels a model honors
 * is gateway- and model-dependent, which is why the route can offer a ladder
 * the catalog does not publish per model.
 */
export type OpenGatewayReasoningEffort = typeof VERBATIM_REASONING_EFFORTS[number]

/** One resolution's connection facts: the OpenAI facts plus the gateway base the catalog reads. */
export type OpenGatewayConnectionOptions = OpenAIConnectionOptions & {
  /** Endpoint base whose `/models` document this route lists. */
  catalogBaseURL: string
  /** Efforts offered on every model of this route, in display order. */
  reasoningEfforts: readonly OpenGatewayReasoningEffort[]
}

/** Constructor options: the OpenAI operation hooks with the catalog-aware option thunk. */
export interface OpenGatewayAdapterOptions extends Omit<OpenAIAdapterOptions, 'options'> {
  options: (provider: string) => OpenGatewayConnectionOptions
  /** The shared catalog client; one instance serves every route. */
  catalog: OpenGatewayCatalog
  /** Receives catalog refresh failures a stale snapshot absorbed. */
  onCatalogError?: (error: unknown) => void
}

function toModelInfo(provider: string, model: OpenGatewayModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    // The inherited chat-completions and Responses serializers carry text
    // only, so a gateway-advertised image capability is not offerable here.
    inputModalities: ['text'],
  }
}

/**
 * The harness LLM transport for OpenGateway: inherited chat/Responses
 * generation plus discovery from the gateway's own catalog.
 */
export class OpenGatewayAdapter extends OpenAIAdapter {
  readonly #options: (provider: string) => OpenGatewayConnectionOptions
  readonly #catalog: OpenGatewayCatalog
  readonly #onCatalogError: ((error: unknown) => void) | undefined

  constructor(options: OpenGatewayAdapterOptions) {
    super(options)
    this.#options = options.options
    this.#catalog = options.catalog
    this.#onCatalogError = options.onCatalogError
  }

  /**
   * The gateway's current models. An unreachable or empty catalog yields an
   * empty list — the route stays registered and recovers on the next query.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const connection = this.#options(provider)
    let entries: ReadonlyMap<string, OpenGatewayModel>
    try {
      entries = await this.#catalog.models(connection.catalogBaseURL, this.#onCatalogError)
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
    const connection = this.#options(provider)
    const entry = this.#catalog.peek(connection.catalogBaseURL)?.get(model)
    // The ladder belongs to the route, not the snapshot: a model the catalog
    // has not seen yet still offers the levels its requests could send, and a
    // catalog outage does not remove the effort control from a live session.
    const reasoning = modelReasoningInfo(connection.reasoningEfforts)
    const info: LlmResolvedModelInfo = entry === undefined ? resolved : {
      ...resolved,
      name: entry.name ?? resolved.name,
      inputModalities: ['text'],
      // The gateway advertises the real capacity; the configured default
      // only serves models the snapshot has not seen yet.
      ...(entry.contextWindow === undefined ? {} : { context: { contextWindow: entry.contextWindow } }),
      ...(entry.maxTokens === undefined ? {} : { defaultMaxTokens: entry.maxTokens }),
    }
    return reasoning === undefined ? info : { ...info, reasoning }
  }
}
