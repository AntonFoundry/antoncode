---
description: "English"
kind: "package-reference"
---

# `@deepseek-ai/dsh-llm-vazhi`

English

## Summary

English

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)

## Understand the implementation

English

This provider registers `vazhi` on `ctx.llm`: a free-model pool route over anonymous and keyed OpenAI-compatible upstreams, ported from [vazhi](https://github.com/itsgg/vazhi) (MIT, © itsgg). Model `auto` walks the pool in ranked order; any other id pins one `upstream/model` entry, and a pinned model that fails reports its own provider error instead of falling through.

Upstream base URLs live in [`src/providers.ts`](src/providers.ts) and nowhere else. `kilo`, `ovh`, and `llm7` are anonymous; `nvidia`, `google`, `openrouter`, `ollama-cloud`, and `zai-free` resolve `NVIDIA_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_API_KEY`, and `ZAI_API_KEY`. The managed credential store wins over the launching environment. An upstream without a key is simply absent from the picker, and a pinned model on it fails `MISSING_CREDENTIAL` naming the reference.

The pool document is untrusted input: only a model whose own upstream's free-tier rule admits it enters the pool, so a downloaded or user-supplied document can reorder free models but cannot move a prompt to another endpoint or admit a paid model. The bundled [`pool.json`](pool.json) ships with the package; a newer document from `poolURL` replaces it at mount and on `poolRefreshMs`, and `$DSH_HOME/vazhi/config.json` narrows it with `prefer` (reorder), `exclude` (drop a model or an upstream prefix), or `pool`/`models` (a complete replacement, validated exactly like a download).

Failures are classified from provider wording (auth, denied, per-minute, hourly, daily, quota, gone, slow, rate, client) and cool the affected model down with an exponential backoff bounded per class. A provider-stated delay wins, with a five-second floor. On upstreams whose rate limits are shared across their models (`sharedLimits` in the pool document), a second report from a different model within two minutes cools the upstream too. `state.json` under the same directory carries this across processes through an atomic write under a file lock; it is a cache of what recently failed, never authority, so an unreadable file costs a few retries rather than the route.

A request walks at most `maxAttempts` upstreams. It stops walking the moment a chunk reached the consumer, because a retry after partial output would duplicate it, and a caller abort never penalizes a model. When no pool model is ready, the error names the wait; when the attempt budget runs out, it reports the last failure.

The `llm-vazhi:` settings section accepts `displayName`, `directory`, `poolURL`, `poolRefreshMs`, `poolRetryAfterMs`, `poolTimeoutMs`, `reasoningEfforts`, `maxAttempts`, `slowStartMs`, `slowForMs`, `maxTokens`, `defaultContextWindow`, `streamIdleTimeoutMs`, and `retryPolicy`. Options resolve for each request, so a changed value reaches the next turn; the pool download cadence and the captured retry policy take effect on the next mount or registration.

The picker offers a reasoning-effort ladder on every model of the route, including `auto`. The pool document carries no per-model effort vocabulary, so the route advertises one configured ladder (`reasoningEfforts`, `low`, `medium`, and `high` by default) and sends a selected label verbatim as `reasoning_effort`; which levels an upstream honors is upstream- and model-dependent. An empty `reasoningEfforts` list hides the control.

## Model Experience

### Vazhi request

#### What the model sees

The adapter forwards the Harness system text, message history, and tool schemas unchanged to whichever pool model answers. It adds no prompt text of its own and rewrites no tool schema, so the model does not learn that a pool chose it, that earlier attempts failed, or that another upstream is cooling down. Requests declare `inputModalities: ['text']`: the inherited `chat-completions` serializer carries text only.

#### Token effect

Prompt and completion tokens follow the Harness request, capped by the pool entry's `maxTokens` when the document carries one and by `maxTokens` otherwise. A failed attempt before the first content chunk re-sends the whole prompt to the next upstream, so one answered request can cost the prompt once per failed attempt; attempts stop as soon as output reaches the consumer. Context capacity comes from the pool entry's `contextWindow`, or `defaultContextWindow` when the document carries none.

#### KV Cache effect

Each attempt targets a different upstream endpoint, so a failover starts a cold cache on the next provider and cannot reuse the failed attempt's prefix. Within one upstream, turns resend the same prefix and the adapter sets no cache policy; the provider decides reuse.

### Vazhi response

#### What the model sees

Text, reasoning, and tool-call deltas arrive as Harness stream chunks from the inherited `chat-completions` translator of whichever upstream answered. Tool calls execute through Harness tools, never through an upstream-side agent loop.

#### Token effect

Only loop-retained blocks affect later input. A response cut short by a mid-stream failure is surfaced as that attempt's failure rather than retried, so no partial output is duplicated.

#### KV Cache effect

Loop-retained response blocks append to the next request and preserve its earlier reusable prefix. Changing the route, the model, or the upstream a pool entry resolves to selects a different cache domain.

## Known Limitations and Deferred Work

- `auto` selection is invisible to the model. A model that benefits from task-specific prompting cannot tell which upstream answered, and the route cannot hand per-model prompt guidance to the loop.
- Free-model coverage depends on the published pool document and on each upstream's live availability. An empty or stale document, or an upstream that changed its free tier, shows up as an empty or shorter picker rather than as an admission error.
- Cooldowns are local to the harness home. Two machines sharing one upstream account do not see each other's rate limits until the provider answers with one.
- The pool document carries no effort vocabulary, so the picker cannot hide levels an upstream rejects; the route offers its configured ladder on every model, and a selected level is the caller's choice.
- Pinned ids name `upstream/model`. A model the pool document does not carry is not routable even when its upstream is reachable, because admission is what the pool decides.

## Dev Note

- See the module JSDoc for the owning contract and its rationale.
