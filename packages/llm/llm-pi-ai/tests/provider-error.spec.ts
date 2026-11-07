import { describe, expect, it, vi } from 'vitest'
import { PiAiErrorObserver } from '../src/provider-error.ts'

const fallback = { message: 'opaque upstream failure', code: 'PI_AI_ERROR' }

describe('per-request pi-ai error observation', () => {
  it('preserves transport cause and leaves unsupported protocols unchanged', async () => {
    const cause = new Error('socket closed')
    const observer = new PiAiErrorObserver()
    const options = { fetch: vi.fn(() => Promise.reject(cause)) }
    expect(observer.options('bedrock-converse-stream', options)).toBe(options)
    await expect(observer.options('openai-completions', options).fetch?.('http://local.invalid')).rejects.toBe(cause)
    expect(observer.error(fallback)?.cause).toBe(cause)
  })

  it('composes supplied observers and leaves response bytes available to the SDK', async () => {
    const observer = new PiAiErrorObserver()
    const response = new Response(JSON.stringify({ error: { code: 'model_not_found' } }), { status: 404 })
    const onResponse = vi.fn()
    const onProviderStreamEvent = vi.fn()
    const options = observer.options('openai-responses', { fetch: () => Promise.resolve(response), onResponse, onProviderStreamEvent })
    expect(options.onResponse).toBe(onResponse)
    expect(await options.fetch?.('http://local.invalid')).toBe(response)
    expect(await response.json()).toEqual({ error: { code: 'model_not_found' } })
    expect(observer.error(fallback)?.failure).toMatchObject({ code: 'MODEL_UNAVAILABLE', status: 404 })
    const model = { id: 'm' } as never
    const event = { type: 'response.failed', response: { error: { code: 'insufficient_quota' } } }
    await options.onProviderStreamEvent?.(event, model)
    expect(onProviderStreamEvent).toHaveBeenCalledWith(event, model)
    expect(observer.error(fallback)?.cause).toBe(event)
  })

  it.each(['not json', 'x'.repeat(65_537)])('retains HTTP facts without trusting malformed or oversized bodies', async (body) => {
    const observer = new PiAiErrorObserver()
    const response = new Response(body, { status: 503, headers: { 'retry-after': 'invalid', 'x-request-id': '' } })
    await observer.options('openai-completions', { fetch: () => Promise.resolve(response) }).fetch?.('http://local.invalid')
    expect(observer.error(fallback)?.failure).toEqual({ ...fallback, code: 'SERVER', status: 503 })
  })

  it('propagates body abort without leaving observation pending', async () => {
    const observer = new PiAiErrorObserver()
    const controller = new AbortController()
    const response = new Response(new ReadableStream({
      start(stream) { controller.signal.addEventListener('abort', () => { stream.error(controller.signal.reason) }) },
    }), { status: 503 })
    const request = observer.options('openai-completions', { fetch: () => Promise.resolve(response) }).fetch?.('http://local.invalid')
    controller.abort(new Error('request cancelled'))
    await expect(request).resolves.toBe(response)
    expect(observer.error(fallback)?.failure.status).toBe(503)
  })
})
