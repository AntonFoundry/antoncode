/**
 * Discovery guards for the OpenGateway catalog client: payload parsing rules
 * (deprecation, text modality, wire protocol), caching, refresh cadence,
 * stale-snapshot survival, and the peek accessors request routing reads.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenGatewayCatalog, parseModels } from '@deepseek-ai/dsh-llm-opengateway'

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'deepseek/deepseek-v4-flash',
    status: 'active',
    modalities: { input: ['text', 'image'] },
    endpoints: ['chat_completions'],
    context_window: 1_000_000,
    max_output_tokens: 65_536,
    ...overrides,
  }
}

function payload(data: unknown[]): { data: unknown[] } {
  return { data }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseModels', () => {
  it('reads ids, modalities, context, output cap, and protocol', () => {
    const models = parseModels(payload([
      model(),
      model({ id: 'openai/o3-pro', endpoints: ['responses'], context_window: 0, max_output_tokens: 1.5 }),
    ]))
    expect([...models.keys()]).toEqual(['deepseek/deepseek-v4-flash', 'openai/o3-pro'])
    expect(models.get('deepseek/deepseek-v4-flash')).toEqual({
      id: 'deepseek/deepseek-v4-flash',
      inputModalities: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    })
    expect(models.get('openai/o3-pro')).toEqual({
      id: 'openai/o3-pro',
      inputModalities: ['text', 'image'],
      protocol: 'responses',
    })
  })

  it('skips deprecated, text-free, unservable, and malformed entries', () => {
    const models = parseModels(payload([
      model({ id: 'retired', status: 'deprecated' }),
      model({ id: 'image-only', modalities: { input: ['image'] } }),
      model({ id: 'modalities-missing', modalities: undefined }),
      model({ id: 'messages-only', endpoints: ['messages'] }),
      model({ id: 'endpoints-missing', endpoints: undefined }),
      model({ id: '', status: 'active' }),
      model({ id: 'bad-modalities', modalities: { input: 'text' } }),
      null,
      'string',
    ]))
    expect(models.size).toBe(0)
    // A Responses-capable model with no chat endpoint keeps its protocol.
    expect(parseModels(payload([model({ id: 'both', endpoints: ['responses', 'chat_completions'] })]))
      .get('both')?.protocol).toBeUndefined()
    // Unknown endpoint strings are ignored rather than treated as chat.
    expect(parseModels(payload([model({ id: 'unknown-endpoint', endpoints: [42, 'messages', 'responses'] })]))
      .get('unknown-endpoint')?.protocol).toBe('responses')
  })

  it('rejects a payload that is not an object or has no data array', () => {
    expect(() => parseModels(null)).toThrow(/not an object/)
    expect(() => parseModels([])).toThrow(/no data array/)
    expect(() => parseModels({})).toThrow(/no data array/)
    expect(() => parseModels({ data: 'nope' })).toThrow(/no data array/)
  })
})

describe('OpenGatewayCatalog', () => {
  const okFetchOf = (body: () => unknown): ReturnType<typeof vi.fn> =>
    vi.fn(async () => ({ ok: true, json: async () => body() }))

  it('fetches once per cadence and exposes the snapshot through peek', async () => {
    let body = payload([model()])
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => body }))
    vi.stubGlobal('fetch', fetchMock)
    const catalog = new OpenGatewayCatalog(3_600_000)

    const first = await catalog.models('https://gw.test/v1')
    const second = await catalog.models('https://gw.test/v1')
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(catalog.peek('https://gw.test/v1')).toBe(first)
    expect(catalog.peekProtocol('https://gw.test/v1', 'deepseek/deepseek-v4-flash')).toBeUndefined()
    expect(catalog.peek('https://other.test/v1')).toBeUndefined()

    body = payload([model({ id: 'next' })])
    await catalog.refresh('https://gw.test/v1')
    expect([...catalog.peek('https://gw.test/v1')!.keys()]).toEqual(['next'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('peeks a Responses protocol only for a cached Responses-only model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => payload([model({ id: 'responses-only', endpoints: ['responses'] })]),
    })))
    const catalog = new OpenGatewayCatalog(3_600_000)
    await catalog.models('https://gw.test/v1')
    expect(catalog.peekProtocol('https://gw.test/v1', 'responses-only')).toBe('responses')
    expect(catalog.peekProtocol('https://gw.test/v1', 'missing')).toBeUndefined()
  })

  it('serves the previous snapshot and reports instead of rejecting on refresh failure', async () => {
    let healthy = true
    vi.stubGlobal('fetch', vi.fn(async () => healthy
      ? { ok: true, json: async () => payload([model()]) }
      : { ok: false, status: 503 }))
    const catalog = new OpenGatewayCatalog(3_600_000)
    const onError = vi.fn()
    const first = await catalog.models('https://gw.test/v1')

    healthy = false
    await catalog.refresh('https://gw.test/v1', onError)
    expect(onError).toHaveBeenCalledTimes(1)
    await expect(catalog.models('https://gw.test/v1')).resolves.toBe(first)
  })

  it('reports a stale read that failed to refresh while the snapshot is due', async () => {
    let healthy = true
    vi.stubGlobal('fetch', vi.fn(async () => healthy
      ? { ok: true, json: async () => payload([model()]) }
      : { ok: false, status: 503 }))
    const catalog = new OpenGatewayCatalog(1)
    const onError = vi.fn()
    const first = await catalog.models('https://gw.test/v1')

    healthy = false
    await new Promise(resolve => setTimeout(resolve, 5))
    await expect(catalog.models('https://gw.test/v1', onError)).resolves.toBe(first)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('rejects when no snapshot exists and the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    const catalog = new OpenGatewayCatalog(3_600_000)
    await expect(catalog.models('https://gw.test/v1')).rejects.toThrow(/failed with 500/)
  })

  it('resolves the models path against a trailing-slash base', async () => {
    const fetchMock = okFetchOf(() => payload([model()]))
    vi.stubGlobal('fetch', fetchMock)
    const catalog = new OpenGatewayCatalog(3_600_000)
    await catalog.models('https://gw.test/v1/')
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://gw.test/v1/models')
  })
})
