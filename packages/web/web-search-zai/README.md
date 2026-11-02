# @deepseek-ai/dsh-web-search-zai

English

A [Z.AI](https://docs.z.ai/)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Z.AI's `POST /web_search` endpoint (`search-prime` engine by default) with the same API key as Z.AI chat completions and maps the flat `search_result[]` into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$ZAI_API_KEY` | Z.AI API key (the same key serves chat completions). Empty/absent makes the provider unavailable. |
| `baseURL` | `https://api.z.ai/api/paas/v4` | Endpoint base; `/web_search` is appended. An unparseable value makes the provider unavailable. |
| `searchEngine` | `search-prime` | Search engine backend sent as `search_engine`. |
| `searchDomainFilter` | (unset) | Restrict results to one domain. Unset sends no filter. |
| `searchRecencyFilter` | (unset) | Restrict results to a publication window: `noLimit`, `oneDay`, `oneWeek`, `oneMonth`, or `oneYear`. Unset sends no filter. |
| `count` | `10` | Default result count when a request carries no `maxResults`. Must be within the API's 1–50 range. |

```yaml
- id: web-search-zai
  name: '@deepseek-ai/dsh-web-search-zai'
  config:
    apiKey: !!js process.env.ZAI_API_KEY
```

Select it with the web plugin's `searchProvider: z-ai` (or `$DSH_WEB_SEARCH_PROVIDER=z-ai`). When several providers are registered, selection must be pinned or the seam reports `WEB_PROVIDER_AMBIGUOUS`.

## Mapping

Z.AI returns a flat `search_result[]` and no generated answer, so `content` is omitted. Each result maps to a `WebSearchSource`: `url` ← `link`, `title` ← `title`, `snippet` ← `content`, `publishedAt` ← `publish_date`. An entry without a `link` cannot cite anything and is dropped; duplicate URLs keep the first occurrence. A request's `maxResults` wins over the configured `count` default and is clamped to the API's 1–50 range before sending; the final bound is enforced by the seam. Provider failures (HTTP errors, network failure, unparseable or wrong-shape bodies) surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, summary snippets, and publication dates or its exact `Z.AI search aborted`, `Z.AI search request failed: <error>`, and `Z.AI returned an unprocessable response body: <error>` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Only `searchEngine`/`count`/domain/recency filters are exposed** — Z.AI's other controls (`content_size`, `custom` recency windows with start/end dates) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **No dedicated client settings card** — configuration goes through cordis.yml / user-settings layers; the existing web-search settings card is DeepSeek-namespaced.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (e.g. `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.
