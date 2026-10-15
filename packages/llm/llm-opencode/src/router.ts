/**
 * `OpenCodeRouterAdapter`: one `opencode-free` route over two transports.
 *
 * A stored Zen bearer key selects the direct gateway transport: the model
 * catalog's free tier over OpenCode Zen with the Harness's own tool schemas,
 * so returned tool calls come back to the Harness and execute through
 * Harness tools — never through OpenCode's local agent loop. Without a key
 * the route serves the local OpenCode service's transient generator
 * (text-only; past tool traffic stays quoted context), which is the path
 * that works anonymously today. When the service is unreachable too, the
 * request falls through to anonymous direct — surfacing the gateway's real
 * verdict instead of masking it behind a transport error.
 *
 * Capability surface follows the same split: keyed discovery and model
 * facts come from the Zen catalog (exact effort values, per-model wire
 * protocol); anonymous discovery and facts come from the service (its
 * advertised variants). An effort the service does not advertise fails
 * `INVALID_REQUEST` naming what it does, at request time.
 *
 * @module dsh-llm-opencode/router
 */

import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ModelsDevAdapter } from '@deepseek-ai/dsh-llm-models-dev'
import type { OpenCodeServerAdapter } from './adapter.ts'

/** Constructor options: the two transports plus the per-operation key probe. */
export interface OpenCodeRouterOptions {
  /** Direct Zen transport: catalog discovery, protocol routing, Harness tools. */
  direct: ModelsDevAdapter
  /** Local-service transport: transient text generation, no Harness tools. */
  service: OpenCodeServerAdapter
  /**
   * Whether a real Zen bearer key resolves right now (never the anonymous
   * literal). Runs per operation so a stored key reaches the very next
   * request — and a removed one falls back — without re-registration.
   */
  hasRealKey: () => Promise<boolean>
}

export class OpenCodeRouterAdapter extends LlmAdapter {
  readonly #direct: ModelsDevAdapter
  readonly #service: OpenCodeServerAdapter
  readonly #hasRealKey: () => Promise<boolean>

  constructor(options: OpenCodeRouterOptions) {
    super()
    this.#direct = options.direct
    this.#service = options.service
    this.#hasRealKey = options.hasRealKey
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return this.#direct.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.#direct.providerRetryPolicy(provider)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (await this.#hasRealKey()) return this.#direct.listModels(provider)
    return this.#service.listModels(provider)
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (await this.#hasRealKey()) return this.#direct.resolveModel(provider, model, signal)
    return this.#service.resolveModel(provider, model, signal)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.run(options)
  }

  private async * run(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (await this.#hasRealKey()) {
      // Warm the catalog snapshot before routing: protocol selection reads
      // it synchronously, and a first request racing the mount-time refresh
      // would otherwise misroute a Responses model to chat-completions.
      // A fresh snapshot serves without a fetch; failures keep serving.
      await this.#direct.listModels(options.provider)
      yield* this.#direct.stream(options)
      return
    }
    try {
      yield* this.#service.stream(options)
    } catch (error: unknown) {
      // No key and no reachable service: attempt anonymous direct so the
      // caller gets the gateway's real verdict (currently its free-tier
      // rejection) instead of a misleading transport error. Any other
      // service failure (auth, rate limit, server) propagates untouched.
      if (!(error instanceof LlmError) || error.code !== 'TRANSPORT') throw error
      await this.#direct.listModels(options.provider)
      yield* this.#direct.stream(options)
    }
  }
}
