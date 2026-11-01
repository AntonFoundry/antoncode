/**
 * `VazhiAdapter`: the harness LLM transport for the Vazhi free-model pool.
 *
 * One route, `vazhi`, over the OpenAI-compatible upstreams in
 * {@link PROVIDERS}. Model `auto` walks the pool in ranked order; any other
 * id pins one `provider/model` entry. Each attempt rides the inherited
 * `OpenAIAdapter` transport over an exact endpoint snapshot, so streaming,
 * SSE translation, attribution, and error mapping stay in one place; this
 * adapter owns only the walk — cooldowns in, a penalty or a recovery out —
 * and stops walking the moment a chunk reached the consumer, because a retry
 * after partial output would duplicate it.
 *
 * @module @deepseek-ai/dsh-llm-vazhi/adapter
 */

import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { modelReasoningInfo, OpenAIAdapter, type VerbatimReasoningEffort } from '@deepseek-ai/dsh-llm-openai'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { PoolDocument } from './pool.ts'
import { formatDuration, type VazhiEndpoint } from './providers.ts'
import { choose, type RouterState } from './state.ts'

/** The model id that lets the router choose; every other id pins one pool entry. */
export const AUTO_MODEL = 'auto'

/** Selector label for {@link AUTO_MODEL}. */
export const AUTO_MODEL_NAME = 'Auto (free pool)'

/** Reasoning-effort labels a Vazhi attempt may send verbatim. */
export type VazhiReasoningEffort = VerbatimReasoningEffort

/** One resolution's validated connection and policy facts. */
export interface VazhiResolvedOptions {
  /** Directory holding `state.json`, `pool-cache.json`, and `config.json`. */
  readonly directory: string
  /** Selector label for the route. */
  readonly displayName: string
  /** Efforts offered on every model of this route, in display order. */
  readonly reasoningEfforts: readonly VazhiReasoningEffort[]
  /** Positive context capacity used when the pool carries no exact value. */
  readonly defaultContextWindow: number
  /** Per-request output cap used when the pool carries no exact value. */
  readonly maxTokens: number
  /** Maximum provider idle time while one stream read is outstanding. */
  readonly streamIdleTimeoutMs: number
  /** Upstream attempts one request may make. */
  readonly maxAttempts: number
  /** First-token time above which an attempt counts as a slow starter. */
  readonly slowStartMs: number
  /** How long a slow mark keeps a model behind the rest of the pool. */
  readonly slowForMs: number
  /** Provider-owned request retry policy captured with the registration. */
  readonly retryPolicy: ResolvedRetryPolicy
}

/** The pool, cooldown, and credential operations the adapter drives. */
export interface VazhiRouter {
  /** The pool in effect, in ranked order. */
  loadPool(): Promise<PoolDocument>
  /** The current cooldown state. */
  loadState(): Promise<RouterState>
  /** Upstreams whose credential or anonymous tier can serve right now. */
  availableUpstreams(): Promise<ReadonlySet<string>>
  /** Resolve one pool model's endpoint, or undefined when its upstream cannot serve. */
  endpointOf(model: string): Promise<VazhiEndpoint | undefined>
  /** Record one failed attempt and cool its model down. */
  penalize(model: string, text: string): Promise<void>
  /** Clear whatever cooled a model before the successful attempt started. */
  recover(model: string, startedAt: number): Promise<void>
  /** Record how long the successful attempt took to produce its first token. */
  noteStart(model: string, firstTokenMs: number): Promise<void>
}

/** Constructor options: the per-operation resolution hooks the plugin owns. */
export interface VazhiAdapterOptions {
  /** Current validated options for the route; called once per operation. */
  options: (provider: string) => VazhiResolvedOptions
  /** Pool, cooldown, and credential operations. */
  router: VazhiRouter
  /** Resolve the harness-home anonymous id shared with telemetry and feedback. */
  resolveUserId: () => AnonymousUserId
}

/** Whether a chunk carries the response's first model-produced content. */
function isContentChunk(chunk: StreamChunk): boolean {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta'
}

/** The text a failure is classified and reported from: the transport's code plus its message. */
function failureText(error: unknown): string {
  /* v8 ignore next 2 -- OpenAIAdapter is the only thrower here and it throws LlmError; any other value is stringified defensively. */
  if (!(error instanceof LlmError)) return String(error)
  return `${error.code} ${error.message}`
}

/**
 * The Vazhi pool transport: ranked selection with cooldowns and failover over
 * the inherited OpenAI-compatible stream.
 */
export class VazhiAdapter extends LlmAdapter {
  readonly #options: (provider: string) => VazhiResolvedOptions
  readonly #router: VazhiRouter
  readonly #resolveUserId: () => AnonymousUserId

  constructor(options: VazhiAdapterOptions) {
    super()
    this.#options = options.options
    this.#router = options.router
    this.#resolveUserId = options.resolveUserId
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.#options(provider).displayName }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.#options(provider).retryPolicy
  }

  /**
   * The pool's selectable models: `auto` first, then every admitted model
   * whose upstream can serve right now.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const [pool, available] = await Promise.all([
      this.#router.loadPool(),
      this.#router.availableUpstreams(),
    ])
    const models: LlmModelInfo[] = [{
      provider,
      id: AUTO_MODEL,
      name: AUTO_MODEL_NAME,
      inputModalities: ['text'],
    }]
    for (const entry of pool.pool) {
      if (!available.has(entry.model.slice(0, entry.model.indexOf('/')))) continue
      models.push({
        provider,
        id: entry.model,
        name: entry.meta?.name ?? entry.model,
        inputModalities: ['text'],
      })
    }
    return models
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const options = this.#options(provider)
    const pool = await this.#router.loadPool()
    const entry = pool.pool.find(candidate => candidate.model === model)
    // The ladder belongs to the route: an upstream or pool snapshot that does
    // not advertise effort levels still offers the levels its requests can send.
    const reasoning = modelReasoningInfo(options.reasoningEfforts)
    return {
      provider,
      id: model,
      name: model === AUTO_MODEL ? AUTO_MODEL_NAME : entry?.meta?.name ?? model,
      inputModalities: ['text'],
      context: { contextWindow: entry?.meta?.contextWindow ?? options.defaultContextWindow },
      defaultMaxTokens: entry?.meta?.maxTokens ?? options.maxTokens,
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.#options(options.provider)
    const pool = await this.#router.loadPool()
    const pinned = options.model === AUTO_MODEL ? undefined : options.model
    let entries = pinned === undefined ? pool.pool.map(entry => entry.model) : [pinned]
    if (entries.length === 0) {
      throw new LlmError('llm-vazhi: the free-model pool is empty', 'POOL_EMPTY')
    }
    let failed: string | undefined
    let lastError = 'no free model answered'
    let attempts = 0
    while (attempts < connection.maxAttempts) {
      const state = await this.#router.loadState()
      const pick = choose(entries, state, Date.now(), failed)
      if (pick.model === undefined) {
        // A pick-less pool always names a wait: every entry is cooling down.
        const hint = `; the next one frees up in ${formatDuration(pick.waitMs)}`
        throw new LlmError(
          pinned === undefined
            ? `llm-vazhi: every free model is cooling down${hint}`
            : `llm-vazhi: pinned model ${pinned} is cooling down${hint}`,
          'RATE_LIMIT',
        )
      }
      const endpoint = await this.#router.endpointOf(pick.model)
      if (endpoint === undefined) {
        if (pinned !== undefined) {
          throw new LlmError(
            `llm-vazhi: ${pinned} is not available (unknown upstream, or its API key is unset)`,
            'MISSING_CREDENTIAL',
          )
        }
        // No key in the environment, or an upstream this build does not know:
        // this attempt costs nothing, so it does not consume the attempt budget.
        entries = entries.filter(model => model !== pick.model)
        if (entries.length === 0) throw new LlmError('llm-vazhi: no free model is available', 'POOL_EMPTY')
        continue
      }
      attempts += 1
      const startedAt = Date.now()
      let emitted = false
      let firstTokenMs: number | undefined
      try {
        for await (const chunk of this.#attempt(endpoint, connection).stream({ ...options, model: endpoint.model })) {
          emitted = true
          if (firstTokenMs === undefined && isContentChunk(chunk)) firstTokenMs = Date.now() - startedAt
          yield chunk
        }
      } catch (error) {
        // A caller abort is not a provider failure and must not cool a model down.
        if (options.signal?.aborted === true) throw error
        // Output already reached the consumer; a second attempt would duplicate
        // it, so a mid-stream failure surfaces as this attempt's failure.
        if (emitted) throw error
        const text = failureText(error)
        await this.#router.penalize(pick.model, text)
        lastError = `${pick.model}: ${text.slice(0, 200)}`
        if (pinned !== undefined) throw error
        failed = pick.model
        continue
      }
      await this.#router.recover(pick.model, startedAt)
      if (firstTokenMs !== undefined) await this.#router.noteStart(pick.model, firstTokenMs)
      return
    }
    throw new LlmError(
      `llm-vazhi: no free model answered after ${attempts} attempt(s); last failure ${lastError}`,
      'PROVIDER_EXHAUSTED',
    )
  }

  /** One attempt's transport, pinned to the endpoint and credential resolved for it. */
  #attempt(endpoint: VazhiEndpoint, connection: VazhiResolvedOptions): OpenAIAdapter {
    return new OpenAIAdapter({
      options: () => ({
        baseURL: endpoint.baseURL,
        headers: endpoint.headers,
        displayName: connection.displayName,
        defaults: { reasoningDialect: 'gateway' },
        maxTokens: connection.maxTokens,
        defaultContextWindow: connection.defaultContextWindow,
        models: [],
        streamIdleTimeoutMs: connection.streamIdleTimeoutMs,
        retryPolicy: connection.retryPolicy,
      }),
      resolveApiKey: () => Promise.resolve(endpoint.apiKey),
      resolveUserId: this.#resolveUserId,
    })
  }
}
