import { describe, expect, it } from 'vitest'
import { ZaiSearchProvider, ZAI_DEFAULT_BASE_URL, ZAI_DEFAULT_COUNT, ZAI_DEFAULT_SEARCH_ENGINE } from '@deepseek-ai/dsh-web-search-zai'

/**
 * Real-API smoke for the Z.AI search provider. Self-skips without `$ZAI_API_KEY`
 * (CI has no secrets), per the with-key e2e policy in docs/testing.md.
 */
const apiKey = process.env.ZAI_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('ZaiSearchProvider real API', () => {
  it('returns sources for a live query', async () => {
    const provider = new ZaiSearchProvider({
      apiKey: apiKey!,
      baseURL: process.env.ZAI_BASE_URL ?? ZAI_DEFAULT_BASE_URL,
      searchEngine: ZAI_DEFAULT_SEARCH_ENGINE,
      count: ZAI_DEFAULT_COUNT,
    })
    const result = await provider.search({ query: 'Z.AI web search API', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    expect(result.sources[0]!.url).toMatch(/^https?:\/\//)
  })
})
