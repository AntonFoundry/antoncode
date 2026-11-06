/** One discovered page with snippet text and optional enrichment outcome; discovery alone does not fetch fullContent. */
export interface SearchResult {
  title: string
  url: string
  description: string
  fullContent: string
  contentPreview: string
  wordCount: number
  timestamp: string
  fetchStatus: 'success' | 'error' | 'timeout'
  error?: string
}

/** Search results with the requested limit, discovery count, and search and duration timestamps. */
export interface SearchResponse {
  query: string
  limit: number
  results: SearchResult[]
  totalFound: number
  searchTimestamp: string
  processingTimeMs: number
}

/** Query and optional engine result count and timeout input; timeout is not an overall search deadline. */
export interface SearchOptions {
  query: string
  numResults?: number
  timeout?: number
}

/** Page extraction inputs; timeout is in milliseconds and maxContentLength limits HTTP-parsed text characters. */
export interface ContentExtractionOptions {
  url: string
  timeout?: number
  maxContentLength?: number
}

/** Search query with optional result limit, page-enrichment selection, and content character limit. */
export interface WebSearchToolInput {
  query: string
  limit?: number
  includeContent?: boolean
  maxContentLength?: number
}

/** Search result payload with query, returned-result count, elapsed milliseconds, and optional status text. */
export interface WebSearchToolOutput {
  results: SearchResult[]
  total_results: number
  search_time_ms: number
  query: string
  status?: string
}

// New types for search summaries (snippets only)
/** Discovered page title, URL, snippet, and timestamp without full-page content. */
export interface SearchSummaryResult {
  title: string
  url: string
  description: string
  timestamp: string
}

/** Snippet-only search payload with query, result count, and elapsed milliseconds. */
export interface SearchSummaryOutput {
  results: SearchSummaryResult[]
  total_results: number
  search_time_ms: number
  query: string
}

// New types for single page content
/** Single-page extraction payload with preview and word count, or an error outcome and diagnostic text. */
export interface SinglePageContentOutput {
  url: string
  title: string
  content: string
  contentPreview: string
  wordCount: number
  timestamp: string
  fetchStatus: 'success' | 'error'
  error?: string
}

// Search result with metadata about which search engine was used
/** Search results paired with the selected approach name; an unsuccessful search uses engine None. */
export interface SearchResultWithMetadata {
  results: SearchResult[]
  engine: string
}
