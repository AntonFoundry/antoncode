/**
 * `ZaiSearchProvider`: a `WebSearchProvider` backed by the Z.AI Web Search API
 * (`POST {baseURL}/web_search`, Bearer auth with the same Z.AI key as chat).
 * It maps `link`→`url`, `title`→`title`, `content`→`snippet`, `publish_date`→`publishedAt`,
 * drops entries without a usable link, dedupes by URL, and omits `content`
 * because Z.AI returns no generated answer.
 *
 * @module @deepseek-ai/dsh-web-search-zai/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { ZaiError, ZaiSearchResponse, ZaiSearchResultItem } from './types.ts'

/** Stable id this provider registers under. */
export const ZAI_PROVIDER_ID = 'z-ai'

/** Default Z.AI API base; `/web_search` is the operation. Shares the chat-completions base. */
export const ZAI_DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4'

/** Default search engine backend. */
export const ZAI_DEFAULT_SEARCH_ENGINE = 'search-prime'

/** Default number of results when a request carries no `maxResults`. */
export const ZAI_DEFAULT_COUNT = 10

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Z.AI's accepted result-count range. */
const MIN_COUNT = 1
const MAX_COUNT = 50

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface ZaiSearchProviderOptions {
  /** Z.AI API key. Empty/absent makes the provider unavailable. */
  apiKey: string
  /** Endpoint base; `/web_search` is appended. */
  baseURL: string
  /** Search engine backend sent as `search_engine`. */
  searchEngine: string
  /** Restrict results to one domain. Absent sends no filter. */
  searchDomainFilter?: string
  /** Restrict results to a publication window. Absent sends no filter. */
  searchRecencyFilter?: string
  /** Default result count when a request carries no `maxResults`. */
  count?: number
}

/**
 * Map one Z.AI result to a normalized source, or `undefined` when it carries no
 * usable link (an entry with no URL cannot cite anything, so it is dropped).
 *
 * @param item - one entry of Z.AI's `search_result[]`.
 * @returns the normalized source, or `undefined` when the entry has no link.
 */
export function mapZaiResult(item: ZaiSearchResultItem): WebSearchSource | undefined {
  if (item.link.length === 0) return undefined
  return {
    url: item.link,
    ...item.title.length > 0 ? { title: item.title } : {},
    ...item.content.length > 0 ? { snippet: item.content } : {},
    ...item.publish_date.length > 0 ? { publishedAt: item.publish_date } : {},
  }
}

/**
 * Map a Z.AI response envelope to a normalized search result. Entries without a
 * link are dropped; duplicates by URL keep the first occurrence.
 *
 * @param response - the parsed `POST /web_search` response body.
 * @returns the normalized result with deduplicated sources.
 */
export function mapZaiResponse(response: ZaiSearchResponse): WebSearchResult {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const item of response.search_result ?? []) {
    const source = mapZaiResult(item)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  // Z.AI returns no generated answer, so `content` is omitted. The web service owns the
  // final `maxResults` truncation, so this provider reports `truncated: false`.
  return { sources, truncated: false }
}

/** The Z.AI-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class ZaiSearchProvider implements WebSearchProvider {
  readonly id = ZAI_PROVIDER_ID

  constructor(private readonly options: ZaiSearchProviderOptions) {}

  available(): boolean {
    return this.options.apiKey.length > 0
      && isValidBaseUrl(this.options.baseURL)
      && (this.options.count === undefined || isValidCount(this.options.count))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // A per-request bound wins over the configured default; the API caps both at 50.
    const maxResults = request.maxResults ?? this.options.count ?? ZAI_DEFAULT_COUNT
    const count = Math.min(Math.max(Math.trunc(maxResults), MIN_COUNT), MAX_COUNT)
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/web_search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          search_engine: this.options.searchEngine,
          search_query: request.query,
          count,
          ...this.options.searchDomainFilter !== undefined ? { search_domain_filter: this.options.searchDomainFilter } : {},
          ...this.options.searchRecencyFilter !== undefined ? { search_recency_filter: this.options.searchRecencyFilter } : {},
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Z.AI search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Z.AI search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Z.AI API error (HTTP ${status})`
      try {
        const parsed = await response.json() as ZaiError
        const detail = typeof parsed.error === 'object'
          ? parsed.error.message
          : parsed.error ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Z.AI search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as ZaiSearchResponse
      return mapZaiResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Z.AI search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Z.AI returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a count the API accepts (a whole number within its 1–50 range). */
function isValidCount(count: number): boolean {
  return Number.isInteger(count) && count >= MIN_COUNT && count <= MAX_COUNT
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
