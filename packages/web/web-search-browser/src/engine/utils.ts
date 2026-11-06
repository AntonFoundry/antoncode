/**
 * Utility functions for the web search MCP server
 */

/**
 * Collapse whitespace, trim it, and retain a prefix bounded by JavaScript string slicing.
 * @param text - Text to normalize.
 * @param maxLength - Maximum UTF-16 code units retained, defaulting to 10000.
 * @returns Normalized text prefix without a truncation marker.
 */
export function cleanText(text: string, maxLength: number = 10000): string {
  return text
    .replace(/\s+/g, ' ') // Replace multiple whitespace with single space
    .replace(/\n\s*\n/g, '\n') // Replace multiple newlines with single newline
    .trim()
    .substring(0, maxLength)
}

/**
 * Count nonempty whitespace-delimited tokens rather than linguistic words.
 * @param text - Text to count.
 * @returns Token count, or zero for whitespace-only input.
 */
export function getWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length
}

/**
 * Build a normalized prefix, appending three dots whenever its length equals the limit.
 * @param text - Text to preview.
 * @param maxLength - Prefix limit in UTF-16 code units, defaulting to 500; excludes the added dots.
 * @returns Preview whose dots can also appear when the normalized input exactly fits the limit.
 */
export function getContentPreview(text: string, maxLength: number = 500): string {
  const cleaned = cleanText(text, maxLength)
  return cleaned.length === maxLength ? cleaned + '...' : cleaned
}

/**
 * Read the current wall-clock time for search and extraction metadata.
 * @returns UTC timestamp in ISO 8601 format.
 */
export function generateTimestamp(): string {
  return new Date().toISOString()
}

/**
 * Check URL syntax and HTTP scheme only, without resolving or restricting the destination.
 * @param url - Absolute URL candidate.
 * @returns True for a parseable HTTP or HTTPS URL; false for other schemes or invalid syntax.
 */
export function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Trim a search query and limit its length without escaping or filtering its contents.
 * @param query - Caller-provided search text.
 * @returns Trimmed prefix of at most 1000 UTF-16 code units.
 */
export function sanitizeQuery(query: string): string {
  return query.trim().substring(0, 1000) // Limit query length
}

/**
 * Select one built-in desktop browser user-agent value using Math.random.
 * @returns A Chrome or Safari desktop user-agent string.
 */
export function getRandomUserAgent(): string {
  const userAgents: readonly [string, ...string[]] = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  ]
  return userAgents[Math.floor(Math.random() * userAgents.length)] ?? userAgents[0]
}

/**
 * Wait for a timer without cancellation support.
 * @param ms - Delay passed to setTimeout in milliseconds.
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Recognize a PDF pathname by suffix, without inspecting response headers or content.
 * @param url - URL to parse; an unparseable value is checked as a raw string instead.
 * @returns True when the parsed pathname, or raw fallback, ends in .pdf ignoring case.
 */
export function isPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.pathname.toLowerCase().endsWith('.pdf')
  } catch {
    // If URL parsing fails, check the raw string as fallback
    return url.toLowerCase().endsWith('.pdf')
  }
}
