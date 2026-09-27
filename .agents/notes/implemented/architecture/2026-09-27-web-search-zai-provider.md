# Agent Note: web-search-zai — Z.AI Web Search API provider

Status: implemented

English

## Problem

The harness had search providers for DeepSeek (LLM-backed), Exa, and Perplexity, but no Z.AI path. Z.AI's Web Search API (`POST /web_search`, same key as its OpenAI-compatible chat completions) was the requested backend.

## Decision

New implementation package `packages/web/web-search-zai`, cloned from `web-search-exa` (the closest structural match: plain HTTP search endpoint, flat result array) rather than `web-search-deepseek` (whose provider is a server-side LLM request, a different shape). Provider id is `z-ai`; selection is the standard config-driven path (`web` plugin's `searchProvider` / `$DSH_WEB_SEARCH_PROVIDER`), so the package ships as a bundle peer without a `cordis.patch.yml` default row — enabling it alongside the DeepSeek provider requires pinning selection or the seam reports `WEB_PROVIDER_AMBIGUOUS`.

Mapping: `link`→`url`, `title`→`title`, `content`→`snippet`, `publish_date`→`publishedAt`; link-less entries drop, URLs dedupe first-wins, per-request `maxResults` clamps to the API's 1–50 range. `redirect: 'error'` retained per the web packages' credential-bearing-request rule, with a dedicated redirect spec proving the target is never contacted. Deferred: `content_size`, `custom` recency windows, a dedicated client settings card (the existing card is DeepSeek-namespaced).

## Unrelated repairs absorbed to unblock shared gates

`gen-doc-graphs` and the README gates failed on pre-existing gaps from the in-flight `model-intel` work; fixed here because they block every doc regeneration: five missing JSDoc `@param`/`@returns` in `model-intel/src/index.ts`, `ModelIntelDatasheet` type-link exemption, `modelIntel`/`toolMatcher` `SERVICE_ROLES` entries, and the model-intel README's Model Experience/Known Limitations final-two ordering. Still failing (pre-existing, untouched): `web-search-browser` short Model Experience audit entry, `llm-models-dev` and `llm-openai` Known Limitations sections, and type errors in `packages/llm/llm-models-dev/src/index.ts` and `apps/cli/src/anton-rebuild.ts`.
