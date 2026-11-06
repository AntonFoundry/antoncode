---
description: "Search public engines without an API key, with optional page-content snippets and browser fallback."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-browser

English

## Summary

A scrape-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It requires no API key: results come from public search engines — Bing and Brave through dedicated Playwright browsers, with an axios DuckDuckGo HTML fallback — and each source's snippet comes from the engine result or, optionally, from extracted page content.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Config](#config)
- [Mapping](#mapping)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Understand the implementation

A scrape-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It requires no API key: results come from public search engines — Bing and Brave through dedicated Playwright browsers, with an axios DuckDuckGo HTML fallback — and each source's snippet comes from the engine result or, optionally, from extracted page content.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). It is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `headless` | `true` | Launch browsers without a visible window. |
| `browserTypes` | `chromium,firefox` | Comma-separated Playwright kinds for the pooled browser (`chromium`, `firefox`, `webkit`). The chromium kind uses the system Chrome channel; the Bing/Brave paths launch dedicated browsers regardless of this pool. |
| `fetchContent` | `false` | After a search, extract page text for each result and use it as the source's `snippet`. Slower and heavier; off by default. |
| `timeoutMs` | `12000` | Per-search budget the engine splits across its fallback engines. |
| `snippetLength` | `1000` | Character cap on an enriched (`fetchContent`) snippet. |

```yaml
- id: web-search-browser
  name: '@deepseek-ai/dsh-web-search-browser'
```

Because the provider is always usable, deployments that also register credential-backed search providers must select explicitly via the web seam's `searchProvider: browser` config or `$DSH_WEB_SEARCH_PROVIDER=browser`.

## Mapping

Each engine result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← the result description unless it is the engine's "No description available" placeholder (with `fetchContent` enabled, an extracted page excerpt wins). No `publishedAt`: scraped engines expose no reliable date. Provider failures surface as `WebError` `WEB_PROVIDER_ERROR`; aborts surface as `WEB_ABORTED` even though the underlying engine cannot observe the signal — the provider races the abort and tears down pooled browsers on cancellation.

## Model Experience

### Search result consumer

#### What the model sees

The provider registers no model tool. The [web tools](../tool-web/README.md) present its URLs, titles, snippets, and `Browser search failed: <error>` failures under the consumer's error wrapper; engine diagnostics stay outside model context.

#### Token effect

Only consumer-rendered result pages and errors add model tokens. Enabling `fetchContent` can increase snippet content up to the configured `snippetLength` bound.

#### KV Cache effect

The provider adds no request prefix. The web-tool consumer owns schemas and appended result content.

## Known Limitations and Deferred Work

- **The vendored engine logs verbosely to the console** — `src/engine/` is adapted from the `web-search-mcp` project and emits per-step console output; routing it through the harness logger is deferred until that project's upstream is stable enough to re-sync.
- **Cancellation is cooperative at the provider layer only** — a torn-down browser stops the current work, but an in-flight axios request completes unobserved.
- **Engine availability shifts** — Bing/Brave markup selectors break without notice; DuckDuckGo is the stable last resort.

### Dev Note

- See the module JSDoc for the owning contract and its rationale.
