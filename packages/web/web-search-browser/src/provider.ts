/**
 * `BrowserSearchProvider`: a `WebSearchProvider` backed by scraped search-engine
 * results (Bing → Brave → DuckDuckGo fallback via Playwright/axios). No API key
 * is involved. Optional content enrichment extracts page text into each
 * source's `snippet`. The engine carries no cancellation support, so aborts are
 * raced at this layer and tear down pooled browsers.
 * @module @deepseek-ai/dsh-web-search-browser/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import { EnhancedContentExtractor } from './engine/enhanced-content-extractor.ts'
import { SearchEngine } from './engine/search-engine.ts'
import type { SearchResult } from './engine/types.ts'

/** Stable id this provider registers under. */
export const BROWSER_PROVIDER_ID = 'browser'

/** Default per-search budget for one engine attempt chain (the engine splits it across engines). */
export const BROWSER_DEFAULT_TIMEOUT_MS = 12_000

/** Default character cap applied to a source's enriched snippet. */
export const BROWSER_DEFAULT_SNIPPET_LENGTH = 1_000

/** Resolved provider options (the plugin's `apply` fills constant defaults). */
export interface BrowserSearchProviderOptions {
  /** Launch browsers without a visible window. Defaults to true. */
  headless: boolean
  /** Comma-separated Playwright browser kinds for the pool (`chromium`, `firefox`, `webkit`). */
  browserTypes: string
  /** Extract full page content per result into `snippet`. Slower; defaults to false. */
  fetchContent: boolean
  /** Per-search engine timeout budget in milliseconds. */
  timeoutMs: number
  /** Character cap on an enriched snippet. */
  snippetLength: number
}

/**
 * Map one scraped engine result to a normalized source. Placeholder descriptions
 * ("No description available") are dropped rather than invented as snippets.
 *
 * @param result - one entry of the engine's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no usable URL.
 */
export function mapEngineResult(result: SearchResult): WebSearchSource | undefined {
  if (result.url.length === 0) return undefined
  const hasSnippet = result.description.length > 0 && result.description !== 'No description available'
  return {
    url: result.url,
    ...result.title.length > 0 ? { title: result.title } : {},
    ...hasSnippet ? { snippet: result.description } : {},
  }
}

/** The scrape-backed search provider. */
export class BrowserSearchProvider implements WebSearchProvider {
  readonly id = BROWSER_PROVIDER_ID

  private readonly engine: SearchEngine
  private readonly extractor: EnhancedContentExtractor | undefined

  /**
   * @param options - resolved provider options.
   */
  constructor(
    private readonly options: BrowserSearchProviderOptions,
    engine = new SearchEngine({
      headless: options.headless,
      browserTypes: options.browserTypes,
      maxBrowsers: 1,
    }),
  ) {
    this.engine = engine
    this.extractor = options.fetchContent ? new EnhancedContentExtractor() : undefined
  }

  /** No credential or endpoint is involved, so the provider is always locally usable. */
  available(): boolean {
    return true
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfSearchAborted(signal)
    let results: SearchResult[]
    try {
      const outcome = await raceAbort(
        this.engine.search({
          query: request.query,
          numResults: request.maxResults ?? 5,
          timeout: this.options.timeoutMs,
        }),
        signal,
        () => {
          // The engine cannot observe the abort itself; tearing down its
          // browsers stops the underlying work instead of leaving it running.
          return this.engine.closeAll()
        },
      )
      results = outcome.results
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(`Browser search failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    let sources = results
      .map(mapEngineResult)
      .filter((source): source is WebSearchSource => source !== undefined)

    const extractor = this.extractor
    if (extractor !== undefined && sources.length > 0) {
      try {
        const enriched = await raceAbort(
          extractor.extractContentForResults(results, results.length),
          signal,
          () => extractor.closeAll(),
        )
        const contentByUrl = new Map(enriched.map(result => [result.url, result.contentPreview]))
        sources = sources.map((source) => {
          const content = contentByUrl.get(source.url)
          return content !== undefined && content.length > 0
            ? { ...source, snippet: content.slice(0, this.options.snippetLength) }
            : source
        })
      } catch (error: unknown) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        // Enrichment is best-effort: snippet-less results remain usable.
      }
    }

    // The web service owns the final `maxResults` truncation, so this provider
    // reports `truncated: false`.
    return { sources, truncated: false }
  }

  /** Close every pooled browser; called when the owning plugin unloads. */
  async dispose(): Promise<void> {
    await this.engine.closeAll()
    await this.extractor?.closeAll()
  }
}

/**
 * Race a cancellation-unaware operation against caller abort. On abort the
 * operation keeps running in the background while the `stop` callback tears
 * down what it can.
 */
function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined, stop: () => Promise<void>): Promise<T> {
  if (signal === undefined || !signal.aborted) {
    return attachStop(operation, signal, stop)
  }
  void stop()
  return Promise.reject(searchAborted(signal))
}

/**
 * Keep observing an uncooperative operation after abort so a later rejection
 * cannot become unhandled.
 */
function attachStop<T>(operation: Promise<T>, signal: AbortSignal | undefined, stop: () => Promise<void>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void stop().catch(() => {})
      reject(searchAborted(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Browser search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as {@link WebError} `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
