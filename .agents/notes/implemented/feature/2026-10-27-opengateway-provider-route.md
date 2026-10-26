# Agent Note: OpenGateway provider route

Status: implemented

## Problem

The operator's other tooling routes models through [OpenGateway](https://opengateway.ai), an OpenAI-compatible gateway at `https://apis.opengateway.ai/v1` that fronts DeepSeek, OpenAI, and other vendors under one bearer key. Harness had no route to it: `llm-openai` reaches one OpenAI-compatible endpoint but discovers models only from a static composition list, and `llm-models-dev` reads models.dev rather than the gateway's own catalog, which is where the gateway advertises each model's context window, output cap, deprecation status, and which wire protocols it serves.

## Decision

`@deepseek-ai/dsh-llm-opengateway` registers the `opengateway` route on `ctx.llm` and ships enabled in `bundle/base`; a request without a stored key fails `MISSING_CREDENTIAL` naming `OPENGATEWAY_API_KEY` rather than failing the plugin at load.

**Discovery reads the gateway itself.** `GET /v1/models` is unauthenticated and returns one entry per model with `id`, `status`, `modalities.input`, `endpoints`, `context_window`, `max_output_tokens`, and `pricing`. The catalog client parses only what the harness can act on: `id`, optional name, context window, output cap, and required text input. Deprecated entries are dropped, as is any model that advertises neither `chat_completions` nor `responses` — the two protocols this adapter can speak — so a picker entry never routes to a translator that does not exist.

**Protocol is per model.** A model advertising `chat_completions` uses the inherited chat transport. A model advertising only `responses` declares `responses`, which `OpenAIAdapter` already supports through `modelProtocol`, so streaming, error mapping, abort semantics, and attribution stay in one place. Both inherited serializers are text-only, so discovery declares `inputModalities: ['text']` even where the gateway advertises image input.

**The catalog is a cache, never a hard dependency.** The plugin warms the snapshot at mount and refreshes on `catalogRefreshMs` (28.8M ms default), and a read past the cadence refetches lazily. A failed refresh keeps the last good snapshot and warns; a failed first fetch yields an empty picker rather than an unregistered route, so a gateway outage never removes a working model selection.

**Connection facts resolve per operation.** `resolveAdapterOptions` is the one explicit resolve step, so a settings change to `baseURL`, `apiKeyEnv`, `displayName`, `headers`, `maxTokens`, `defaultContextWindow`, or `streamIdleTimeoutMs` reaches the next request without re-registration. The one registration-captured fact is the retry policy: a settings change to it re-registers the route in place in one synchronous section. `catalogRefreshMs` is captured by the mount-time interval and takes effect at the next restart, matching the models.dev family.

**Credentials resolve per request** through the managed credentials service first and the launching environment second, and the resolved key always belongs to the same resolution as the endpoint it is sent to.

## Alternatives considered

- **Reuse `llm-openai` with a static model list.** Rejected: the gateway rotates its catalog, and a hand-maintained list would silently lose context windows, output caps, and the Responses-only models it serves.
- **Reuse `llm-models-dev`'s catalog.** Rejected: models.dev does not know the gateway's account-specific reachability or its `endpoints` vocabulary, so it cannot answer which protocol a model needs.
- **Filter discovery by advertised price.** Rejected: pricing is account- and plan-dependent, and the gateway remains the authority on what a key can call. The picker lists what the catalog lists.
- **Drop the `pricing` and `endpoints` fields at parse time.** Rejected for `endpoints`, which decides the wire protocol. Accepted for `pricing`, which no harness surface consumes yet.

## Consequences

- The picker shows exactly what the gateway advertises, including models the key cannot call and models retired after the snapshot; the request-time provider error stays authoritative.
- A gateway catalog outage degrades the picker, not the route: a session already on a model keeps streaming.
- Reasoning-effort controls are absent because the catalog carries no effort vocabulary; requests send none.
- Anthropic-Messages-only models stay unreachable until a Messages-protocol transport exists.
