/**
 * `@deepseek-ai/dsh-web-search-zai`: registers a Z.AI-backed `WebSearchProvider`
 * with `ctx.web`. A function/namespace plugin (NOT a default-export service):
 * a search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `@deepseek-ai/dsh-llm-deepseek`
 * registers an adapter into `ctx.llm`. The key is owned by `@deepseek-ai/dsh-web`.
 *
 * @module @deepseek-ai/dsh-web-search-zai
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  ZaiSearchProvider,
  ZAI_DEFAULT_BASE_URL,
  ZAI_DEFAULT_SEARCH_ENGINE,
} from './provider.ts'

export {
  ZAI_DEFAULT_BASE_URL,
  ZAI_DEFAULT_COUNT,
  ZAI_DEFAULT_SEARCH_ENGINE,
  ZAI_PROVIDER_ID,
  ZaiSearchProvider,
} from './provider.ts'
export type { ZaiSearchProviderOptions } from './provider.ts'

/** Accepted `search_recency_filter` values (Z.AI's `custom` window is deferred). */
export const SEARCH_RECENCY_FILTERS = ['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear'] as const
export type SearchRecencyFilter = typeof SEARCH_RECENCY_FILTERS[number]

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-zai'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Z.AI API key (same key as chat completions). Falls back to `$ZAI_API_KEY`. Empty → provider unavailable. */
  apiKey?: string
  /** Endpoint base; `/web_search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Search engine backend sent as `search_engine`. Defaults to `search-prime`. */
  searchEngine?: string
  /** Restrict results to one domain. Absent sends no filter. */
  searchDomainFilter?: string
  /** Restrict results to a publication window. Absent sends no filter. */
  searchRecencyFilter?: SearchRecencyFilter
  /** Default result count when a request carries no `maxResults`. Defaults to 10 (API range 1–50). */
  count?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  searchEngine: z.string(),
  searchDomainFilter: z.string(),
  searchRecencyFilter: z.union(SEARCH_RECENCY_FILTERS),
  count: z.number().step(1).min(1).max(50),
})

/** Register the Z.AI search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new ZaiSearchProvider({
    // Every environment layer may name this key: the product trusts the
    // project it is launched in, and the managed store is not involved here.
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('ZAI_API_KEY')?.value ?? '',
    baseURL: config.baseURL ?? ZAI_DEFAULT_BASE_URL,
    searchEngine: config.searchEngine ?? ZAI_DEFAULT_SEARCH_ENGINE,
    ...config.searchDomainFilter !== undefined ? { searchDomainFilter: config.searchDomainFilter } : {},
    ...config.searchRecencyFilter !== undefined ? { searchRecencyFilter: config.searchRecencyFilter } : {},
    ...config.count !== undefined ? { count: config.count } : {},
  }))
}
