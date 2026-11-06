# Agent Note: web-search-zai — Z.AI Web Search API provider

Status: implemented

English

## Problem

The harness had search providers for DeepSeek (LLM-backed), Exa, and Perplexity, but no Z.AI path. Z.AI's Web Search API (`POST /web_search`, same key as its OpenAI-compatible chat completions) was the requested backend.

## Decision

New implementation package `packages/web/web-search-zai`, cloned from `web-search-exa` (the closest structural match: plain HTTP search endpoint, flat result array) rather than `web-search-deepseek` (whose provider is a server-side LLM request, a different shape). Provider id is `z-ai`; selection is the standard config-driven path (`web` plugin's `searchProvider` / `$DSH_WEB_SEARCH_PROVIDER`), so the package ships as a bundle peer without a `cordis.patch.yml` default row — enabling it alongside the DeepSeek provider requires pinning selection or the seam reports `WEB_PROVIDER_AMBIGUOUS`.

Mapping: `link`→`url`, `title`→`title`, `content`→`snippet`, `publish_date`→`publishedAt`; link-less entries drop, URLs dedupe first-wins, per-request `maxResults` clamps to the API's 1–50 range. `redirect: 'error'` retained per the web packages' credential-bearing-request rule, with a dedicated redirect spec proving the target is never contacted. Deferred: `content_size`, `custom` recency windows, a dedicated client settings card (the existing card is DeepSeek-namespaced).

## Consequences

The provider remains opt-in: mounting it beside another search provider requires explicit selection. Redirects are refused on credential-bearing requests. Custom recency windows, content-size controls, and a dedicated settings card remain deferred.

## Alternatives considered

**Use the LLM-backed DeepSeek search provider as the implementation template.** Rejected: Z.AI exposes a plain HTTP search endpoint with a flat result list, matching the Exa adapter rather than a model-generated search response.
