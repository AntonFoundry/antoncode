/**
 * Wire types for the Z.AI search API (`POST https://api.z.ai/api/paas/v4/web_search`).
 * Types only — no runtime code. Z.AI returns a flat `search_result[]`; each entry
 * carries a `link`, `title`, summary `content`, site `media` name, `icon`, and
 * `publish_date`.
 *
 * @module @deepseek-ai/dsh-web-search-zai/types
 */

/** Request body sent to Z.AI's search endpoint. */
export interface ZaiSearchRequest {
  /** Search engine backend; `search-prime` is the LLM-oriented default. */
  search_engine: string
  /** The user query. */
  search_query: string
  /** Z.AI's result-count control (1–50); the seam still enforces the bound on return. */
  count?: number
  /** Restrict results to one domain. */
  search_domain_filter?: string
  /** Restrict results to a publication window (`noLimit`, `oneDay`, `oneWeek`, `oneMonth`, `oneYear`). */
  search_recency_filter?: string
}

/** One entry of Z.AI's flat `search_result[]`. */
export interface ZaiSearchResultItem {
  link: string
  title: string
  /** Summary text for the page. */
  content: string
  /** Site display name (e.g. `Sohu`). */
  media: string
  icon: string
  /** Publication date, `YYYY-MM-DD`, or an empty string when unknown. */
  publish_date: string
  /** Z.AI's citation reference id (e.g. `ref_1`). */
  refer: string
}

/** Z.AI's search response envelope. */
export interface ZaiSearchResponse {
  search_result?: ZaiSearchResultItem[]
}

/** Z.AI's error response envelope (best-effort; fields vary by failure). */
export interface ZaiError {
  error?: { message?: string } | string
  message?: string
}
