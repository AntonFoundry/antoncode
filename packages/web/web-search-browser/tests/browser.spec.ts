import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as browserPlugin from '@deepseek-ai/dsh-web-search-browser'
import {
  BROWSER_PROVIDER_ID,
  BrowserSearchProvider,
} from '@deepseek-ai/dsh-web-search-browser'
import type { SearchResult, SearchResultWithMetadata } from '../src/engine/types.ts'
import { mapEngineResult } from '../src/provider.ts'

/** Stub engine standing in for the scrape pipeline in registration tests. */
function stubEngine(results: SearchResult[]): {
  search(options: { query: string }): Promise<SearchResultWithMetadata>
  closeAll(): Promise<void>
} {
  return {
    search: async () => ({ results, engine: 'Stub' }),
    closeAll: async () => {},
  }
}

function engineResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Title',
    url: 'https://a.test',
    description: 'A snippet',
    fullContent: '',
    contentPreview: '',
    wordCount: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    fetchStatus: 'success',
    ...overrides,
  }
}

describe('Browser result mapping', () => {
  it('maps title and snippet, dropping the placeholder description', () => {
    expect(mapEngineResult(engineResult())).toEqual({ url: 'https://a.test', title: 'Title', snippet: 'A snippet' })
    expect(mapEngineResult(engineResult({ description: 'No description available' })))
      .toEqual({ url: 'https://a.test', title: 'Title' })
  })

  it('drops entries without a URL', () => {
    expect(mapEngineResult(engineResult({ url: '' }))).toBeUndefined()
  })
})

describe('web-search-browser plugin registration', () => {
  function registeredProviders(ctx: Context): Map<string, unknown> {
    return (ctx as never as { web: { searchProviders: Map<string, unknown> } }).web.searchProviders
  }

  it('registers the provider into ctx.web and unregisters with the fiber (HMR-safe)', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BROWSER_PROVIDER_ID })
    const fiber = await ctx.plugin(browserPlugin, {})
    expect(registeredProviders(ctx).has(BROWSER_PROVIDER_ID)).toBe(true)
    await fiber.dispose()
    expect(registeredProviders(ctx).has(BROWSER_PROVIDER_ID)).toBe(false)
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in browserPlugin).toBe(false)
  })

  it('caps an enriched snippet at the configured length', async () => {
    const long = 'x'.repeat(50)
    const enriched = [engineResult({ contentPreview: long })]
    const engine = {
      search: async () => ({ results: [engineResult()], engine: 'Stub' }),
      closeAll: async () => {},
    }
    const provider = new BrowserSearchProvider(
      { headless: true, browserTypes: 'chromium', fetchContent: true, timeoutMs: 1_000, snippetLength: 10 },
      engine as never,
    )
    ;(provider as unknown as { extractor: { extractContentForResults(): Promise<SearchResult[]>; closeAll(): Promise<void> } })
      .extractor = {
        extractContentForResults: async () => enriched,
        closeAll: async () => {},
      }
    const result = await provider.search({ query: 'q' })
    expect(result.sources[0]?.snippet).toBe('x'.repeat(10))
  })

  it('maps an engine failure to WEB_PROVIDER_ERROR', async () => {
    const provider = new BrowserSearchProvider(
      { headless: true, browserTypes: 'chromium', fetchContent: false, timeoutMs: 1_000, snippetLength: 100 },
      { search: async () => Promise.reject(new Error('all engines failed')), closeAll: async () => {} } as never,
    )
    await expect(provider.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort during search to WEB_ABORTED', async () => {
    const controller = new AbortController()
    const provider = new BrowserSearchProvider(
      { headless: true, browserTypes: 'chromium', fetchContent: false, timeoutMs: 1_000, snippetLength: 100 },
      {
        search: () => new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
        closeAll: async () => {},
      } as never,
    )
    const pending = provider.search({ query: 'q' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('rejects immediately when the caller already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const provider = new BrowserSearchProvider(
      { headless: true, browserTypes: 'chromium', fetchContent: false, timeoutMs: 1_000, snippetLength: 100 },
      stubEngine([]) as never,
    )
    await expect(provider.search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})
