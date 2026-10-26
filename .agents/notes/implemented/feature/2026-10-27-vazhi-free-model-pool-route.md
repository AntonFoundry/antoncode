# Agent Note: Vazhi free-model pool route

Status: implemented

## Problem

The operator's other tooling routes free models through [vazhi](https://github.com/itsgg/vazhi) (MIT, © itsgg), a pool router over OpenAI-compatible upstreams that admit unauthenticated tiers (`kilo`, `ovh`, `llm7`) and keyed free tiers (`nvidia`, `google`, `openrouter`, `ollama-cloud`, `zai-free`). Harness had no route to that pool: `llm-openai` reaches one endpoint with a static model list, and a hand-maintained list would neither follow the published pool nor survive each upstream's rate limits.

## Decision

`@deepseek-ai/dsh-llm-vazhi` registers the `vazhi` route on `ctx.llm` and ships enabled in `bundle/base`. Model `auto` walks the pool in ranked order; any other id pins one `upstream/model` entry.

**Admission, not pool content, decides what is routable.** Pool documents are untrusted input from three sources: the bundled `pool.json`, the `poolURL` download, and `$DSH_HOME/vazhi/config.json`. Base URLs stay in `PROVIDERS`; `parsePool` drops every entry the upstream's own free-tier rule rejects, and metadata is read only for ids that already passed admission, so a tampered document can reorder free models but cannot redirect a prompt or admit a paid model. `prefer` reorders keys the pool already carries, `exclude` drops a key or an upstream prefix, and `pool`/`models` replace the document under the same validation.

**Each attempt rides the inherited OpenAI transport over an exact endpoint snapshot.** `VazhiAdapter` builds one `OpenAIAdapter` per attempt from the resolved endpoint and key, so SSE translation, error mapping, abort semantics, and attribution stay in `llm-openai`; this package owns only the walk. The walk stops the moment a chunk reached the consumer, because a retry after partial output would duplicate it, and a caller abort penalizes nothing. An upstream with no resolvable key is filtered out of the picker and skipped without spending an attempt; a pinned model on it fails `MISSING_CREDENTIAL` naming the reference.

**Failure policy is provider wording, not deployment preference,** so it stays fixed rather than configurable: `classify` maps provider text to a kind with a base and ceiling, a stated `Retry-After` wins with a five-second floor, and consecutive failures double the cooldown up to the class ceiling. On upstreams whose limits are shared across their models, a second report from a different model within two minutes cools the upstream as well.

**Cooldowns are a cross-process cache.** `$DSH_HOME/vazhi/state.json` is written through an atomic rename under a sibling file lock, read back through a sanitizer that drops entries a writer would not have produced, and treated as advisory: an unreadable or unwritable file costs retries, never the route. A successful attempt clears what predates it, so a recovered upstream is not held down by stale state.

**Options resolve per request.** `resolveAdapterOptions` is the one explicit resolve step; a settings change to `displayName`, `directory`, `poolURL`, the download timeouts, `maxAttempts`, `slowStartMs`, `slowForMs`, `maxTokens`, `defaultContextWindow`, or `streamIdleTimeoutMs` reaches the next request. The mount-time interval captures `poolRefreshMs`, and the captured retry policy re-registers the route in place when a settings snapshot changes it.

## Alternatives considered

- **Reuse `llm-openai` with a hand-written free-model list.** Rejected: the published pool changes as upstream free tiers change, and a static list would silently keep routing to models that stopped being free.
- **Trust the pool document's `models` metadata for admission.** Rejected: it is the same untrusted input as the entries, so metadata is read only for ids the upstream's rule already admitted.
- **Let `prefer` add a model the pool lacks.** Rejected: it turned a typo into a route and let a preferred key bypass the upstream's free-tier rule; adding models is what the `pool` replacement is for.
- **Retry after output already reached the consumer.** Rejected: the consumer would see duplicated text or repeated tool calls.
- **Fail the mount when no upstream has a key.** Rejected: the anonymous tier needs no key, and a missing key is a request-time fact (`MISSING_CREDENTIAL`, or an empty picker entry) that a later key fills without a restart.
- **Make the cooldown table configurable.** Rejected: the wording it matches is each provider's own, so a configurable table could only misclassify.

## Consequences

- A pool model is routable only while its upstream's free tier still admits it and its key (if any) resolves; otherwise the picker shortens and `auto` skips it.
- Request cost can exceed one prompt per answered turn: each failed attempt before the first content chunk re-sends the prompt to the next upstream.
- Failover starts a cold KV cache on the next upstream, and the model cannot tell that a pool chose it or that earlier attempts failed.
- Cooldowns are local to one harness home; two machines on the same upstream account only learn the shared limit when the provider states it.
- Context capacity and output caps come from the pool document when it carries them, from `defaultContextWindow`/`maxTokens` otherwise; a stale document understates a model rather than overstating it.
