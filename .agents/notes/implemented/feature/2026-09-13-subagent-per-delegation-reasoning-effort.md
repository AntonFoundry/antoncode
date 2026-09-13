# Agent Note: Per-delegation subagent reasoning effort

Status: implemented

English | [中文](2026-09-13-subagent-per-delegation-reasoning-effort.zh.md)

## Problem

The swarm's model routing gave a parent fine-grained control over **which model** each child ran ([swarm defaults](../../../packages/subagent/tool-subagent/README.md#child-model-routing-swarm-defaults)) but none over **how hard** it thought. `AgentOptions` carried `provider`, `model`, and `maxTokens` only; `reasoningEffort` existed solely on `LlmCallConfig`, seeded from a session's persisted `request/header` or injected through `agent/request`. A fresh child therefore always ran at its model's adapter default: a parent delegating a needle-in-a-haystack grep to a cheap model and a design decision to a strong one could tune neither, and the Settings subagent card had no effort surface to compensate. The gap compounded with the routing feature — a `provider/model` route could land a child on a model whose default effort was wrong for the task with no way to correct it.

## Decision

Reasoning effort becomes part of the agent-options inheritance chain, symmetric with `maxTokens`:

- `AgentOptions` gains `reasoningEffort?: string` (`dsh-agent`). The field is an unbranded string at this boundary; the loop brands it once at the call-config edge.
- The agent loop seeds a session without a usable persisted effort from `this.options.reasoningEffort` (branded through `ReasoningEffortId`), then persists through the logged header as before. The existing resume rule — retain the logged effort only while the initial route is unchanged ([adapter-owned reasoning effort capabilities](../architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md)) — keeps precedence; the options fallback fires only when the persisted header names no effort, which also covers seeded child sessions whose inherited header carries none.
- `resolveChildAgentOptions` inherits the parent's effort beside `provider`/`model`/`maxTokens`, and a request's own `agentOptions.reasoningEffort` overrides it.
- `tool-subagent` exposes `reasoningEffort` as a per-delegation enum argument and threads it into the start request's agent options, alone or beside a `model` route. Its plugin-config `agentOptions` accepts a deployment-level `reasoningEffort` default the same way.

Validation stays where the [adapter-owned capabilities](../architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md) note put it: the child's selected provider checks the id per model at `prepareCall`, and an unserviceable effort fails that child's request with `UNSUPPORTED_REASONING_EFFORT` — surfacing as an errored delegation result, never a silently degraded one. The tool's schema enum advertises the widest portable set (`off` … `max`); adapters remain the authority.

## Testing

Loop-level: a fresh agent with `AgentOptions.reasoningEffort` seeds its first request header from the options and later turns persist the value; the mock model declares only the effort the test names, so a pass proves seeding rather than an adapter default. Driver-level: a parent with an effort passes it to the child's options and requests, and the request's own override wins. Tool-level: the schema pins the new parameter in both background-enabled and disabled instances, and captured-start assertions prove the call's effort reaches the provider alone and beside a route.

## Alternatives considered

**A settings-section default beside `subagent-child-model.defaultModel`.** The model route needed its four-layer chain because different children legitimately want different models; a single global effort default had no per-session consumer and would have re-implemented the config surface the plugin's `agentOptions` already owns. The per-call argument plus config default covers the expressed need.

**Branding `AgentOptions.reasoningEffort` as `ReasoningEffortId`.** The agent-options boundary crosses plugin config (Schemastery strings) and tool JSON; branding there would force every caller to cast while adding no validation the provider does not already own at `prepareCall`.

**Teaching the UI card instead of the tool.** A card-only control would not let the delegating model match effort to task — the caller that knows the subtask's difficulty is the model writing the prompt.

## Consequences

Children can now run any supported effort their model advertises, per delegation. A resumed child keeps its logged effort; a child whose session was seeded with an effort-less header adopts its options' effort on first request, matching `maxTokens` symmetry. Out-of-process providers (`acp`, `codex`, `dsh-sdk`) ignore the new field until their spawn specs carry it — the in-process path is the only one this change wires, and their configs fail loud per route rather than silently.
