/**
 * `OpenCodeRouterAdapter`: one `opencode-free` route over three transports,
 * picked per operation.
 *
 * - **OAuth workspace session**: direct inference gateway with the stored
 *   workspace token — the only path that serves free-tier models with tool
 *   calling today. Zero-cost turns additionally take the free-tier gate
 *   (identity headers, marker/flattened history, text-protocol tools parsed
 *   back into harness tool-call chunks), so returned calls execute through
 *   Harness tools, never through OpenCode's local agent loop.
 * - **Stored Zen bearer key**: direct Zen gateway with the Harness's own
 *   tool schemas.
 * - **Local service**: explicit service mode or anonymous routing uses the
 *   local transient generator with text-protocol Harness tools. In auto mode,
 *   when the service is
 *   unreachable too, the request falls through to anonymous direct —
 *   surfacing the gateway's real verdict instead of a misleading error.
 *
 * Capability surface follows the transport: keyed and OAuth discovery and
 * model facts come from the Zen catalog (exact effort values, per-model
 * wire protocol), optionally narrowed by the workspace allowlist;
 * anonymous discovery and facts come from the service (its advertised
 * variants). An effort the service does not advertise fails
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
import { augmentSystemWithTextProtocol, parseFreeTextTools } from './zen-gate.ts'

/** One resolved transport: the serving adapter plus shaping and filtering. */
export interface OpenCodeTransport {
  /** Require the local service without falling back to a direct gateway. */
  serviceOnly?: boolean
  /** Adapter serving this operation (request-scoped for OAuth). */
  adapter: ModelsDevAdapter | OpenCodeServerAdapter
  /** Zero-cost shaping applies: system augment plus text-tool parsing. */
  freeTier: boolean
  /**
   * Which credential posture selected this transport; owns the auth-failure
   * guidance appended to `AUTH` errors so the failed chat turn tells the
   * operator the fix (usually `dsh opencode-login`).
   */
  via: 'oauth' | 'keyed' | 'service'
  /**
   * Wire protocol the serving adapter will use for this operation. Set on
   * OAuth plans so the router applies text-protocol shaping only on Responses
   * turns; chat-protocol free turns ride native tools. Absent means
   * chat-completions (service and keyed plans, where the router never
   * reshapes).
   */
  protocol?: 'chat-completions' | 'responses'
  /** Workspace allowlist narrowing discovery; absent means unfiltered. */
  allowedModels?: readonly string[]
}

/** Constructor options: transports plus the per-operation transport plan. */
export interface OpenCodeRouterOptions {
  /** Local-service transport: transient generation with Harness-owned text-protocol tools. */
  service: OpenCodeServerAdapter
  /** Keyed-or-anonymous direct transport: catalog discovery, protocol routing, Harness tools. */
  direct: ModelsDevAdapter
  /**
   * Resolve one operation's transport plan: OAuth workspace session, else
   * keyed direct, else anonymous service. Runs per operation so a login or
   * a stored key reaches the very next request — and a removal falls back —
   * without re-registration. Warms the catalog snapshot for protocol
   * selection before routing.
   */
  resolveTransport: (options: Pick<GenerateOptions, 'provider' | 'model' | 'purpose'>) => Promise<OpenCodeTransport>
}

export class OpenCodeRouterAdapter extends LlmAdapter {
  readonly #service: OpenCodeServerAdapter
  readonly #direct: ModelsDevAdapter
  readonly #resolveTransport: OpenCodeRouterOptions['resolveTransport']

  constructor(options: OpenCodeRouterOptions) {
    super()
    this.#service = options.service
    this.#direct = options.direct
    this.#resolveTransport = options.resolveTransport
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return this.#direct.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.#direct.providerRetryPolicy(provider)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const plan = await this.#resolveTransport({ provider, model: '' })
    const models = await plan.adapter.listModels(provider)
    if (plan.allowedModels === undefined) return models
    const allowed = new Set(plan.allowedModels)
    return models.filter(model => allowed.has(model.id))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const plan = await this.#resolveTransport({ provider, model })
    return plan.adapter.resolveModel(provider, model, signal)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.run(options)
  }

  private async * run(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const plan = await this.#resolveTransport(options)
    if (plan.adapter === this.#service) {
      try {
        yield* this.#service.stream(options)
      } catch (error: unknown) {
        // No OAuth, no key, no reachable service: attempt anonymous direct
        // so the caller gets the gateway's real verdict instead of a
        // misleading transport error. Any other service failure (auth, rate
        // limit, server) propagates untouched.
        if (plan.serviceOnly || !(error instanceof LlmError) || error.code !== 'TRANSPORT') throw error
        // Warm the catalog snapshot before routing: protocol selection reads
        // it synchronously, and a first request racing the mount-time refresh
        // would otherwise misroute a Responses model to chat-completions.
        await this.#direct.listModels(options.provider)
        try {
          yield* this.#direct.stream(options)
        } catch (fallback: unknown) {
          throw withAuthHint(fallback, 'service')
        }
      }
      return
    }
    try {
      // Text-protocol shaping is Responses-only: chat-protocol free turns
      // ride native tools (the live gateway 400s Responses for models that
      // only serve chat-completions).
      if (plan.freeTier && plan.protocol === 'responses' && options.purpose === undefined) {
        yield* parseFreeTextTools(plan.adapter.stream(augmentSystemWithTextProtocol(options)))
        return
      }
      yield* plan.adapter.stream(options)
    } catch (error: unknown) {
      throw withAuthHint(error, plan.via)
    }
  }
}

/**
 * Auth-failure guidance naming the fix for each credential posture. Appended
 * to the `AUTH` message (never replacing it) so the failed chat turn tells
 * the operator what to run; every other failure travels untouched.
 */
function authHint(via: OpenCodeTransport['via'], detail: string): string {
  if (via === 'oauth') {
    // Free-tier gate verdicts name the client, not the credential: observed
    // live against a valid session, so re-login cannot fix them.
    if (/free tier can only be used from within|FreeTierError/i.test(detail)) {
      return 'The gateway\'s free-tier gate rejected this client despite a valid workspace session (re-login cannot fix a client rejection). Text turns still serve through the local OpenCode service; tool-capable free-tier turns need a genuine OpenCode client network stack.'
    }
    return 'The stored OpenCode Zen workspace session was rejected by the gateway. Re-run `dsh opencode-login` (or the Log in button on the Models page), then retry.'
  }
  if (via === 'keyed') {
    return 'The stored Zen key was rejected by the gateway. Check the stored key, or run `dsh opencode-login` (or the Log in button on the Models page) for a keyless workspace session, then retry.'
  }
  return 'The opencode-free route has no usable Zen workspace session and the anonymous gateway request was rejected. Run `dsh opencode-login` (or the Log in button on the Models page) to log in, then retry.'
}

/** Re-raise an auth failure with login guidance; everything else passes through. */
function withAuthHint(error: unknown, via: OpenCodeTransport['via']): unknown {
  if (!(error instanceof LlmError) || error.code !== 'AUTH') return error
  return new LlmError(`${error.message}\n${authHint(via, error.message)}`, error.code, { cause: error })
}
