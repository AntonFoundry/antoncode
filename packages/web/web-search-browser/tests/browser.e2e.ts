import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as browserPlugin from '@deepseek-ai/dsh-web-search-browser'

/**
 * Live-network smoke for the scrape-backed search provider. Self-skips without
 * `$DSH_BROWSER_SEARCH_E2E=true` (CI has no Playwright browsers), per the
 * with-key e2e policy in docs/testing.md.
 */
const enabled = process.env.DSH_BROWSER_SEARCH_E2E === 'true'
const maybe = enabled ? describe : describe.skip

maybe('BrowserSearchProvider live network', () => {
  it('returns sources for a live query through ctx.web', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'browser' })
    const fiber = await ctx.plugin(browserPlugin, { headless: true })
    try {
      const result = await ctx.web.search({ query: 'DeepSeek Harness github', maxResults: 5 })
      expect(result.sources.length).toBeGreaterThan(0)
      for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
    } finally {
      await fiber.dispose()
    }
  }, 120_000)
})
