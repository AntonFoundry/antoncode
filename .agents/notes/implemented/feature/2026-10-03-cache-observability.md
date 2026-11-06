# Agent Note: Cache observability — hit-rate projection and per-subagent usage

Status: implemented

English

## Problem

Subagent continuation is prefix-preserving by construction: a continued child replays its persisted session prefix, so automatic-prefix-cache providers (DeepSeek, OpenAI) serve it at cached rates, while every freshly spawned agent pays full uncached input. The harness already accounted `cacheReadTokens`/`cacheWriteTokens` per request and folded them into the durable `tokenUsage` projection, but nothing derived a hit-rate ratio, and no per-subagent surface exposed usage — so the continuation-versus-respawn economics the design implies were unmeasurable and invisible to the model choosing between `send_message` and a fresh delegation.

## Decision

Derive the ratio at the projection view, and carry usage through the existing listing pipeline; no provider-request changes and no new capability seam. The `tokenUsage` fold semantics are owned by [projected token usage and request context](../architecture/2026-07-29-projected-token-usage-and-request-context.md) and are unchanged here; this note adds the derived view field and the per-child surfacing. The listing rungs are owned by [subagent list identity via the projection unit](../../archived/architecture/2026-08-06-subagent-list-identity-projection.md).

- `tokenUsage`'s view publishes the derived `cacheHitRate` — `cacheReadTokens / (uncachedInputTokens + cacheReadTokens + cacheWriteTokens)` — absent until a request reports usage, which distinguishes "no data" from a legitimate 0. The projection state and `stateVersion` are unchanged; the ratio is a view-time derivation from the totals, following the `contextPressure.projectedTokens` precedent. Stale projection-cache rows that predate the field remain valid (optional field) and simply lack the ratio until their next fold.
- `SubagentRuntime.listChildren()`/`listDescendants()` attach the child's served `tokenUsage` value to each child row (all three rungs: live watermark snapshot, projection-cache row, persistence re-fold) under `usage`, absent before the child's first usage report and when the token-meter unit is not registered. The fold already computed every registered unit per child; the row previously read only `.values.subagent`.
- The `list_agents` tool passes `usage` through to the model and renders it as a compact `tokens[in=… out=… cache-read=… cache-write=… hit=<p>%]` bracket, with the tool description steering toward `send_message` for high-hit children.

## Consequences

- Session-scope hit-rate is observable wherever the `tokenUsage` projection is served; per-child economics are visible to the model at delegation time without any new tool.
- `cacheHitRate` counts cache writes as uncached prompt tokens (they are misses), and a pure-cache request yields 1.
- `dsh-subagent` and `dsh-tool-subagent-control` gain a type-only workspace dependency on `dsh-token-meter` (the projection vocabulary's client face).
- Anthropic-style providers without automatic prefix caching still report zero cache traffic; the ratio is an observation, not a control — explicit cache breakpoints remain out of scope.

## Files

- `packages/llm/token-meter/src/projection.ts`, `src/usage-projection.ts` — type, helper, view, schema
- `packages/subagent/subagent/src/list-children.ts` — usage passthrough on the three rungs
- `packages/subagent/tool-subagent-control/src/list-agents.ts` — output schema, render, description
- Snapshot expected outputs pinning the `list_agents` description (19 files under `examples/acp-agent/tests/snapshots/`)

## Alternatives considered

**Add a separate usage tool or change provider requests.** Unnecessary: the existing token-usage projection already records cache counts, and the child listing already serves registered projections. Deriving and forwarding the ratio exposes the observation without another capability or provider control.
