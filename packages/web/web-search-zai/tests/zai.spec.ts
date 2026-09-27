import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { ZaiSearchProvider, ZAI_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-zai'
import * as zaiPlugin from '@deepseek-ai/dsh-web-search-zai'
import { mapZaiResponse, mapZaiResult } from '../src/provider.ts'

const options = { apiKey: 'zai-key', baseURL: 'https://api.zai.test/v4', searchEngine: 'search-prime' }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Z.AI result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapZaiResult({
      link: 'https://a.test',
      title: 'A',
      content: 'summary text',
      media: 'Site',
      icon: 'https://a.test/icon.png',
      publish_date: '2026-01-01',
      refer: 'ref_1',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'summary text', publishedAt: '2026-01-01' })
  })

  it('drops a result with no link', () => {
    expect(mapZaiResult({ link: '', title: 'A', content: 'c', media: '', icon: '', publish_date: '', refer: '' }))
      .toBeUndefined()
  })

  it('omits empty optional fields rather than emitting them', () => {
    expect(mapZaiResult({ link: 'https://a.test', title: '', content: '', media: '', icon: '', publish_date: '', refer: '' }))
      .toEqual({ url: 'https://a.test' })
  })

  it('maps a response to a result with no content, filtered sources, and no content answer', () => {
    const result = mapZaiResponse({
      search_result: [
        { link: 'https://a.test', title: 'A', content: 'one', media: '', icon: '', publish_date: '', refer: 'ref_1' },
        { link: '', title: 'B', content: 'two', media: '', icon: '', publish_date: '', refer: 'ref_2' },
        { link: 'https://c.test', title: 'C', content: 'three', media: '', icon: '', publish_date: '2026-02-02', refer: 'ref_3' },
      ],
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'one' },
        { url: 'https://c.test', title: 'C', snippet: 'three', publishedAt: '2026-02-02' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('dedupes sources by URL, keeping the first occurrence', () => {
    const result = mapZaiResponse({
      search_result: [
        { link: 'https://a.test', title: 'first', content: '', media: '', icon: '', publish_date: '', refer: '' },
        { link: 'https://a.test', title: 'second', content: '', media: '', icon: '', publish_date: '', refer: '' },
      ],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test', title: 'first' }])
  })

  it('tolerates a missing search_result array', () => {
    expect(mapZaiResponse({}).sources).toEqual([])
  })
})

describe('ZaiSearchProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(new ZaiSearchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(new ZaiSearchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new ZaiSearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when count is outside the API range', () => {
    expect(new ZaiSearchProvider({ ...options, count: 0 }).available()).toBe(false)
    expect(new ZaiSearchProvider({ ...options, count: 51 }).available()).toBe(false)
    expect(new ZaiSearchProvider({ ...options, count: 10.5 }).available()).toBe(false)
    expect(new ZaiSearchProvider({ ...options, count: 50 }).available()).toBe(true)
  })
})

describe('ZaiSearchProvider request mapping', () => {
  it('sends engine, query, count and bearer auth with redirect rejection', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ search_result: [{ link: 'https://a.test', title: 'A', content: 'c', media: '', icon: '', publish_date: '', refer: '' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new ZaiSearchProvider({ ...options, searchDomainFilter: 'www.sohu.com', searchRecencyFilter: 'oneWeek' })
    await provider.search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.zai.test/v4/web_search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer zai-key')
    expect(JSON.parse(init.body as string)).toEqual({
      search_engine: 'search-prime',
      search_query: 'hello',
      count: 5,
      search_domain_filter: 'www.sohu.com',
      search_recency_filter: 'oneWeek',
    })
  })

  it('falls back to the configured count when a request omits maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ search_result: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new ZaiSearchProvider({ ...options, count: 20 }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ count: 20 })
  })

  it('uses the default engine and count 10 when nothing is configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ search_result: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new ZaiSearchProvider(options).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ search_engine: 'search-prime', count: 10 })
    expect(JSON.parse(init.body as string)).not.toHaveProperty('search_domain_filter')
    expect(JSON.parse(init.body as string)).not.toHaveProperty('search_recency_filter')
  })

  it('clamps an oversized per-request bound to the API maximum', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ search_result: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new ZaiSearchProvider(options).search({ query: 'q', maxResults: 500 })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ count: 50 })
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ search_result: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new ZaiSearchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('ZaiSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the nested provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'bad key' } }, { status: 401 })))
    await expect(new ZaiSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('reads a string error field and a top-level message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'quota exceeded' }, { status: 429 })))
    await expect(new ZaiSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'quota exceeded' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'top level' }, { status: 400 })))
    await expect(new ZaiSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'top level' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(new ZaiSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Z.AI API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(new ZaiSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Z.AI API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new ZaiSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new ZaiSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new ZaiSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ search_result: {} }, { status: 200 })))
    await expect(new ZaiSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new ZaiSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new ZaiSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-zai plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ search_result: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ZAI_PROVIDER_ID })
    const fiber = await ctx.plugin(zaiPlugin, { apiKey: 'zai-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in zaiPlugin).toBe(false)
  })

  it('threads engine, filters and count config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ search_result: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ZAI_PROVIDER_ID })
    const fiber = await ctx.plugin(zaiPlugin, {
      apiKey: 'zai-key',
      searchEngine: 'search-pro',
      searchDomainFilter: 'example.com',
      searchRecencyFilter: 'oneDay',
      count: 3,
    })
    await ctx.web.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({
      search_engine: 'search-pro',
      search_domain_filter: 'example.com',
      search_recency_filter: 'oneDay',
      count: 3,
    })
    await fiber.dispose()
  })

  it('falls back to $ZAI_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.ZAI_API_KEY
    process.env.ZAI_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ search_result: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: ZAI_PROVIDER_ID })
      const fiber = await ctx.plugin(zaiPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url] = fetchMock.mock.calls[0] as unknown as [string]
      expect(url).toBe('https://api.z.ai/api/paas/v4/web_search')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.ZAI_API_KEY
      else process.env.ZAI_API_KEY = prev
    }
  })

  it('is unavailable when neither config nor env supplies a key', async () => {
    const prev = process.env.ZAI_API_KEY
    delete process.env.ZAI_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: ZAI_PROVIDER_ID })
      await ctx.plugin(zaiPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
    } finally {
      if (prev !== undefined) process.env.ZAI_API_KEY = prev
    }
  })
})
