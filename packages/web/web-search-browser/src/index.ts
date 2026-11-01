/**
 * `@deepseek-ai/dsh-web-search-browser`: registers a scrape-backed
 * `WebSearchProvider` (Bing → Brave → DuckDuckGo via Playwright/axios) with
 * `ctx.web`. A function/namespace plugin: the `ctx.web` key is owned by
 * `@deepseek-ai/dsh-web`; this plugin only registers INTO the seam's provider
 * registry, exactly like the other search providers.
 *
 * Because the provider needs no credentials and is always usable, deployments
 * that also register credential-backed providers must select explicitly via the
 * web seam's `searchProvider` config or `$DSH_WEB_SEARCH_PROVIDER`.
 *
 * @module @deepseek-ai/dsh-web-search-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  BROWSER_DEFAULT_SNIPPET_LENGTH,
  BROWSER_DEFAULT_TIMEOUT_MS,
  BrowserSearchProvider,
} from './provider.ts'

export {
  BROWSER_DEFAULT_SNIPPET_LENGTH,
  BROWSER_DEFAULT_TIMEOUT_MS,
  BROWSER_PROVIDER_ID,
  BrowserSearchProvider,
} from './provider.ts'
export type { BrowserSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-browser'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills constant defaults). */
export interface Config {
  /** Launch browsers without a visible window. Defaults to true. */
  headless?: boolean
  /** Comma-separated Playwright browser kinds for the pool (`chromium`, `firefox`, `webkit`). */
  browserTypes?: string
  /** Extract full page content per result into each source's `snippet`. Slower; defaults to false. */
  fetchContent?: boolean
  /** Per-search engine timeout budget in milliseconds. Defaults to 12000. */
  timeoutMs?: number
  /** Character cap on an enriched snippet. Defaults to 1000. */
  snippetLength?: number
}

export const Config: z<Config> = z.object({
  headless: z.boolean().default(true),
  browserTypes: z.string().default('chromium,firefox'),
  fetchContent: z.boolean().default(false),
  timeoutMs: z.number().step(1).min(1).default(BROWSER_DEFAULT_TIMEOUT_MS),
  snippetLength: z.number().step(1).min(1).default(BROWSER_DEFAULT_SNIPPET_LENGTH),
})

/** Register the scrape-backed search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const provider = new BrowserSearchProvider({
    headless: config.headless ?? true,
    browserTypes: config.browserTypes ?? 'chromium,firefox',
    fetchContent: config.fetchContent ?? false,
    timeoutMs: config.timeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS,
    snippetLength: config.snippetLength ?? BROWSER_DEFAULT_SNIPPET_LENGTH,
  })
  ctx.web.registerSearchProvider(provider)
  ctx.effect(function* () {
    yield () => {
      // Pooled browsers must not outlive the registration that created them.
      void provider.dispose()
    }
  }, 'web-search-browser.dispose')
}
