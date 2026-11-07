/** Per-attempt provider error facts captured before pi-ai flattens SDK failures. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmErrorOptions, LlmFailure, ProviderRequestId, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SimpleStreamOptions } from '@earendil-works/pi-ai'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function wireError(value: unknown): Record<string, unknown> | undefined {
  const data = record(value)
  if (data === undefined) return undefined
  const response = record(data['response'])
  return record(data['error']) ?? record(response?.['error'])
    ?? (data['type'] === 'error' ? data : undefined)
}

function errorCode(error: Record<string, unknown> | undefined, status?: number): string | undefined {
  const facts = [error?.['code'], error?.['type']]
  if (status === 401 || status === 403
    || facts.some(code => code === 'authentication_error' || code === 'invalid_api_key' || code === 'permission_error')) return 'AUTH'
  if (facts.includes('context_length_exceeded')) return CONTEXT_WINDOW_EXCEEDED_CODE
  for (const code of facts) {
    switch (code) {
      case 'invalid_request_error': return 'INVALID_REQUEST'
      case 'insufficient_quota':
      case 'billing_not_active':
      case 'usage_limit_reached': return QUOTA_EXCEEDED_CODE
      case 'rate_limit_exceeded':
      case 'rate_limit_error': return 'RATE_LIMIT'
      case 'overloaded_error':
      case 'server_overloaded': return 'OVERLOADED'
      case 'model_unavailable':
      case 'model_not_found': return 'MODEL_UNAVAILABLE'
      default: break
    }
  }
  if (status === 400 || status === 413) return 'INVALID_REQUEST'
  if (status === 429) return 'RATE_LIMIT'
  if (status !== undefined && status >= 500) return 'SERVER'
  return undefined
}

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/** Decode only a bounded complete JSON error body; never search display text for JSON fragments. */
async function responseError(response: Response): Promise<unknown> {
  const reader = response.clone().body?.getReader()
  if (reader === undefined) return undefined
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      // Security invariant: observing an error duplicates at most 64 KiB of wire data.
      if (bytes > 65_536) return undefined
      chunks.push(value)
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder().decode(body))
  } catch (_error) {
    // The SDK still receives the untouched response and owns malformed/body failures.
    return undefined
  } finally {
    // Clone cancellation can wait for the SDK's reader; never await that sibling.
    void reader.cancel().catch((_error: unknown) => {
      // The SDK owns consumption/cancellation errors on the original response.
    })
  }
}

/**
 * Capture one request's supported HTTP/SSE facts without global fetch mutation.
 * Unsupported catalog protocols retain pi-ai's existing string-only behavior.
 */
export class PiAiErrorObserver {
  private facts: LlmErrorOptions = {}
  private providerError: Record<string, unknown> | undefined
  private cause: unknown
  private observed = false

  /**
   * Compose transport/event observers with any existing request hooks.
   * @param api - resolved pi-ai protocol.
   * @param options - request options whose hooks and transport must be preserved.
   * @returns options augmented only for the three supported HTTP protocols.
   */
  options(api: string, options: SimpleStreamOptions): SimpleStreamOptions {
    if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(api)) return options
    const fetchRequest = options.fetch ?? globalThis.fetch
    return {
      ...options,
      fetch: async (input, init) => {
        let response: Response
        try { response = await fetchRequest(input, init) } catch (error) {
          this.cause = error
          this.observed = true
          throw error
        }
        this.facts = { status: response.status }
        const delay = retryAfter(response.headers.get('retry-after'))
        if (delay !== undefined) this.facts.providerRetryAfterMs = delay
        const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
        if (requestId !== null && requestId.length > 0) this.facts.requestId = brandString<ProviderRequestId>(requestId)
        if (!response.ok) {
          this.observed = true
          this.cause = await responseError(response)
          this.providerError = wireError(this.cause)
        }
        return response
      },
      onProviderStreamEvent: async (data, model) => {
        const error = wireError(data)
        if (error !== undefined) {
          this.observed = true
          this.providerError = error
          this.cause = data
        }
        await options.onProviderStreamEvent?.(data, model)
      },
    }
  }

  /**
   * Attach facts to terminal errors, preserving in-band delivery unless a live transport cause exists.
   * @param chunk - translated pi-ai chunk.
   * @returns unchanged success chunks or the structured terminal failure.
   */
  chunk(chunk: StreamChunk): StreamChunk {
    if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return chunk
    const error = this.error(chunk.reason.failure)
    if (error?.cause instanceof Error) throw error
    return error === undefined ? chunk : { ...chunk, reason: { kind: 'error', failure: error.failure } }
  }

  /**
   * Recover Anthropic's whole serialized SSE error and combine observed facts.
   * @param fallback - terminal failure already classified by the converter.
   * @returns a typed error with original transport/wire cause, or undefined if upstream retained only prose.
   */
  error(fallback: LlmFailure): LlmError | undefined {
    if (!this.observed && fallback.message.startsWith('{')) {
      let data: unknown
      try { data = JSON.parse(fallback.message) } catch (_error) {
        // Non-JSON display text carries no structured provider facts.
        return undefined
      }
      const error = wireError(data)
      if (error !== undefined) {
        this.observed = true
        this.providerError = error
        this.cause = data
      }
    }
    if (!this.observed) return undefined
    const structured = errorCode(this.providerError, this.facts.status)
    const code = structured === 'AUTH' ? structured
      : fallback.code === CONTEXT_WINDOW_EXCEEDED_CODE ? fallback.code
        : structured ?? fallback.code
    return new LlmError(fallback.message, code, { ...this.facts, cause: this.cause })
  }
}
