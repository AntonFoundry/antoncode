# Agent Note: Push-based model-catalog freshness and the DeepSeek V4.1 Flash entry

Status: implemented

## Problem

The model selector showed a stale DeepSeek collection for two independent reasons. `llm-deepseek` pins an advisory default catalog at load, and that list predated DeepSeek's V4.1 Flash (`deepseek-flash`) — the official provider's current flash-tier model on models.dev — so no restart could ever show it. And `llm-models-dev` fetched models.dev lazily: discovery only fetched when a picker query needed a snapshot older than `catalogRefreshMs`, and nothing ever re-fetched in the background, so a route whose picker had already been read could serve an arbitrarily old free tier until the process restarted.

## Decision

Discovery freshness in `llm-models-dev` is now push-based. `ModelsDevCatalog.refresh(provider, onError)` fetches now and replaces the cached snapshot regardless of age; a failed fetch reports through `onError` and keeps the previous snapshot instead of rejecting, so an outage never empties a working picker. The plugin calls it once per configured route at mount (deduplicating routes that share a catalog identity) and re-arms it on a fiber-owned `setInterval` at `catalogRefreshMs` — the same knob as the query-time TTL, so the default mount converges on the newest models.dev document at mount and every hour afterward. A settings section that fails `assertServiceable` never reaches the config source, so the tick cannot observe an unresolvable route and needs no defensive guard.

`llm-deepseek` advertises `deepseek-flash` as `DeepSeek-V4.1-Flash` between V4 Flash and V4 Pro in `DEFAULT_MODELS`. The catalog stays advisory: the id is passed through as the wire `model` string, and an explicit `models` list still replaces the defaults wholesale.

The OpenCode free tier cannot list V4.1 Flash today: both models.dev's `opencode` entry and the live `opencode.ai/zen/v1/models` response cap at `deepseek-v4-flash`; `deepseek-v4.1-flash` exists only on the paid `opencode-go` endpoint, and the plugin's picker is models.dev free-tier parity by design.

## Alternatives considered

- **Keep discovery lazy and shorten the TTL** — rejected: a TTL only bounds staleness when someone queries; an unread picker never refreshes, and the user asked for fetch-on-restart plus hourly convergence without depending on picker demand.
- **Clear the cache when a refresh fails** — rejected: a transient models.dev outage would empty the selector; the stale snapshot is strictly better UX and `freeModels` already recovered this way.
- **Have `llm-deepseek` fetch its list from models.dev too** — rejected for now: its catalog is advisory with pass-through ids and deployment-owned entries (private `baseURL` gateways); a live fetch would couple an offline-configurable surface to network state.

## Results

- Every restart fetches the current models.dev document for each configured route before any picker query; every `catalogRefreshMs` (one hour by default) re-fetches in the background; disposal stops the timer.
- A failed refresh logs once through the existing `onCatalogError` path and keeps the last good snapshot for both query-time and pushed discovery.
- The DeepSeek section of the model selector lists `DeepSeek-V4.1-Flash`; `ctx.llm.listModels('deepseek-official')` returns three entries by default.
