---
description: "The retry executor for users and maintainers configuring provider-routed model-request recovery at durable agent-step boundaries."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-retry

English

## Summary

Mount `@deepseek-ai/dsh-llm-retry` to retry failed model requests at durable agent-step boundaries. Provider `retryPolicy` settings choose bounded normal-mode retries or unlimited always-mode retries; scheduled attempts reach the session log before backoff, and cancellation leaves consistent history. Retries re-run the failed step in the same open turn, while direct `ctx.llm.stream()` calls remain single-attempt. Each retry is another billed provider request, and always mode continues until success, cancellation, or disposal.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this Host plugin when agent runs should recover from transient model-request failures instead of ending the turn. Provider adapters own same-route `retryPolicy`; this plugin also accepts optional ordered `failover` chains shared by main and child Sessions. Omitted or disabled failover preserves existing provider recovery.

### When to choose it

Choose it when a composition runs the agent loop and wants durable request recovery. The plugin is a function plugin; provider adapters such as `dsh-llm-deepseek` and `dsh-llm-pi-ai` own the `retryPolicy` for their routes, and multi-provider adapters place it inside each provider profile. Skip it when calls go through `ctx.llm.stream()` directly without the agent loop: those consumers remain single-attempt because a raw stream cannot separate already-emitted chunks durably.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    retryPolicy:
      mode: always
      backoff:
        initialDelayMs: 1000
        maxDelayMs: 30000
        jitterRatio: 0.2

- name: '@deepseek-ai/dsh-llm-retry'
```

Omission of `retryPolicy` uses normal mode: effectively unlimited retries for `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT`, with bounded exponential backoff from 500 ms to 10 seconds and 10 percent jitter. Normal mode can change its finite budget, eligible codes, and backoff; always mode asks downstream recovery first, then retries every model-request failure without an attempt limit, stopping only on success, cancellation, or plugin disposal.

### Ordered automatic failover

Configure `failover` on this Host row, not a preset. Each chain names an exact primary and ordered fallback routes. The configured chain is authorization to send the same logical request to those providers; it does not read or widen the subagent launch allowlist. Keep chains restricted to routes the deployment authorizes. The global model default is never rewritten.

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
  config:
    failover:
      enabled: true
      chains:
        - primary: { provider: codex, model: gpt-6.1-sol }
          fallbacks:
            - { provider: opengateway, model: deepseek/deepseek-v4-pro }
      cooldownMs: 300000
      sameRouteRetries: 1
      retryDelayMs: 500
      maxAttempts: 8
      maxElapsedMs: 120000
      contextHeadroomTokens: 8192
```

For configured chains, structured quota, rate-limit, overload, model-unavailable and server failures enter bounded recovery before the ordinary provider retry policy. Quota and unavailable-model failures advance immediately; other eligible failures first receive `sameRouteRetries` retries. Every failed request and rejected candidate counts toward `maxAttempts`; candidate metadata and retry waits share `maxElapsedMs`. Quota skips remaining candidates using the same provider, conservatively treating its credential quota as shared. Authentication, missing credentials, invalid requests, context overflow, cancellation, transport/timeouts and unknown defects do not cause cross-route recovery; ordinary downstream handlers retain their existing behavior.

The policy resets reasoning effort on fallback so the target adapter selects its own default. Unknown context capacity rejects a candidate. Smaller-context candidates require the optional Host token meter plus a conservative UTF-8 input-byte bound; without the meter, capacity may not decrease. Every automatically selected target is checked again after its actual prompt and tools are assembled, reserving its output cap and configured headroom. Unknown output reserves and retained image/file attachments are rejected rather than silently converted or discarded. Automatic recovery does not compact input to fit another model. Each successful fallback remains selected for that Session's cooldown, then the next request attempts the compatible primary again. A manual model selection clears automatic state. Cooldowns are Session-local, not a provider-wide health service.

Set `enabled: false` to disable automatic recovery without changing provider retry behavior. Configuration rejects duplicate primaries, repeated candidates, cycles within a chain, unknown fields and invalid limits at activation. Installing or changing a Host plugin may recompose the live runtime; stage separately when other work must remain undisturbed.

### What you can observe

Each scheduled retry is durable before its wait: the plugin appends a non-surface `llm/retry` event carrying the retry id, provider, mode, policy key, failure, and scheduled delay, then a `llm/retry-started` event immediately before the retry begins. A valid `Retry-After` from the provider replaces local backoff when it fits the policy bounds. When the wait completes, the loop re-runs the failed step inside the same open turn over the same durable history, so the retried request is reconstructable from the session log exactly like the original. Cancellation or plugin disposal aborts active backoff, drains active delegated recovery, and makes a callback captured before disposal fail closed.

### Failures and recovery

A failure before any final adapter is selected has no provider policy and delegates downstream unchanged. In normal mode, a failure code outside the eligible set, or an exhausted budget, delegates; in always mode, an over-cap provider delay uses the configured local backoff so the policy cannot terminate on that instruction. Same-route retry records, delays, provider errors and failed partial output do not enter derived messages. Enabled failover additionally records `llm/failover`, `llm/failover-attempt` and `llm/failover-exhausted`; switches and exhaustion append a durable user-role notice visible in the conversation and subsequent model request. Exhaustion includes considered routes and stable failure codes, and local subagent completion diagnostics preserve the terminal cause for the parent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the executor; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The executor is built on one rule: **durable before wait, open-step boundaries.** A retry is scheduled through the session log before any timer starts, so a crash or cancellation never leaves an invisible pending retry. Recovery runs on the agent loop's `agent/request-error` waterfall, the open-step extension point, rather than wrapping `ctx.llm.stream()` — a raw stream cannot separate already-emitted chunks durably, while the loop can re-run the failed step inside the same open turn.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The function plugin: waterfall listener, policy lookup, backoff, durable event appends |
| [`src/types.ts`](src/types.ts) | Browser-safe retry and failover event payload types |
| [`src/failover.ts`](src/failover.ts) | Ordered recovery, Session cooldown projection and compatibility checks |
| [`src/failover-config.ts`](src/failover-config.ts) | Validated exact route chains and bounded recovery settings |
| [`src/brand.ts`](src/brand.ts) | The `RetryId` brand shared by the event payloads |

### Recovery flow

The recovery listener is installed before awaiting projection registration. Failures arriving during activation wait for the reader before applying the provider policy. Registration failure propagates to the agent; cancellation or plugin disposal while waiting prevents retry records and further attempts.

A failed step arrives on the waterfall with its provider and resolved policy. Always mode settles downstream recovery first and honors a downstream `retry` decision; normal mode first checks that the failure code is eligible and the budget is not exhausted. The plugin computes the delay — provider `Retry-After` when valid and within bounds, otherwise local bounded exponential backoff with symmetric jitter — appends the `llm/retry` event, waits on a cancellable timer, appends `llm/retry-started`, and returns `{ kind: 'retry' }`. The loop then re-runs the failed step inside the same open turn over the same durable history.

### Waterfall composition

The plugin is one listener in the `agent/request-error` waterfall. Always mode's "downstream first" posture means a later policy that ignores cancellation and never settles also prevents fallback, turn quiescence, and plugin disposal from completing; success, cancellation, or disposal stops always mode after active delegated recovery reaches quiescence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the service contract to the adapters that own retry policies.

- [dsh-llm service](../llm/README.md) — the provider-neutral service whose adapters own `retryPolicy`.
- [llm-deepseek adapter](../llm-deepseek/README.md) — a provider adapter with a route-level `retryPolicy`.
- [llm-pi-ai adapter](../llm-pi-ai/README.md) — a multi-provider adapter with per-profile `retryPolicy`.
- [Terminal LLM stream failures](../../../.agents/notes/implemented/architecture/2026-07-29-terminal-llm-stream-failures.md) — how failures reach the service boundary as terminal chunks.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the `StreamChunk` protocol and adapter contract.

-----

<a id="model-experience"></a>
## Model Experience

### Model-request recovery

#### What the model sees

Ordinary same-route retries add no model-visible text. Enabled automatic route recovery appends a notice such as `[automatic model switch: alpha/primary → beta/backup; QUOTA]`; exhausted recovery appends the considered routes and stable failure codes. Both notices are durable user messages. Failed partial output remains an `assistant/attempt`, never a committed assistant message or executable tool batch. Each route retry resolves the target's tools and prompt again without re-admitting the original user input.

#### Token effect

Each retry is a new provider request and may repeat input-token billing. Normal mode has a finite budget; always mode can consume unbounded requests until success or cancellation. `llm/retry` itself contributes no tokens.

#### KV Cache effect

Same-route requests preserve the prior prefix under provider cache rules. A cross-route attempt may lose provider-side prefix reuse, and its durable switch notice extends model history. Retry and failover audit events themselves are non-surface.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the executor stops and future work begins. They are current package constraints, not a general retry comparison or a task backlog.

- **Failover is opt-in and Session-local** — configure explicit chains on the Host. Public catalog metadata does not establish authenticated availability or account quota. No provider-wide health cache is shared between Sessions.
- **Smaller-context recovery needs the token meter** — without target request-pressure measurement, smaller candidates are rejected. New target prompts or tool sets may still be rejected by their owning preflight; unknown capability metadata is not authorization to discard input.
- **Agent turns are the only retry boundary** — direct `ctx.llm.stream()` consumers remain single-attempt because a raw stream cannot separate already-emitted chunks durably.
- **Always mode retries permanent failures** — authentication, quota, invalid-request, protocol, and unrecoverable context errors continue until success, cancellation, or disposal; deployments own provider-specific cost and latency controls.
- **Finite plugin budgets add** — normal mode counts only its configured codes and exact provider policy, while context-overflow compaction owns a separate budget. Any overlapping policy must define registration-order behavior.
- **Recovery policies compose by waterfall order** — always mode accepts a downstream retry before applying its fallback. A later policy that ignores cancellation and never settles also prevents fallback, turn quiescence, and plugin disposal from completing.
- **`llm/retry` records scheduling, not completion** — later step and turn events establish success, exhaustion, or cancellation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Retry numbers continue only across events with the same provider and complete policy key, so a route replacement with different limits, code membership, or backoff starts its own history; the key includes every behavior-affecting field and sorts normal-mode codes because eligibility uses set membership.

</details>
