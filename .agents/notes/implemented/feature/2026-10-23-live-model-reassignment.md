# Agent Note: Live model reassignment for an exhausted route

Status: implemented

## Problem

`llm-retry` retries a failed model request under a provider-supplied policy, and an exhausted quota or rate limit is routinely classified as retryable `RATE_LIMIT`. The retry loop therefore keeps re-sending the same exhausted route. Before this change there was no way to change the route while that loop was running: `session.selectModel` wrote only the selection captured at the next prompt assembly, so the open step kept retrying its original `assembled` route, and a subagent had no model control at all (`selectModel` rejects subagent sessions with `agent-busy`). A user watching a stuck agent could only cancel it.

## Decision

A model switch now reaches the model request that is already retrying, at both levels of the delegation tree.

**Main session.** `ApiProxyService.selectModel` advances the session's `selection.current` and `selection.assembled` together. `installModelSelection` reads `assembled` on every `agent/request`, so advancing that snapshot is what makes the in-flight step's next attempt use the replacement. The next prompt assembly re-captures `current`, which is already the same value.

**Subagent.** `ctx.subagents.selectModel(targetSessionId, selection, authority)` reassigns one live child's route, and `set_agent_model` is the model-facing tool over it. The service installs an Agent-scoped `installModelSelection` on the child (lazily, on first reassignment) and advances both `current` and `assembled`, so the child's failing attempt retries on the replacement and every later request keeps it. The override store is a process-local `WeakMap` keyed by the exact live `Agent`.

**Authority.** Reassignment accepts only an exact live ancestor: the caller must still be registered under its id (`ctx.agents.get(caller.id) === caller`), must not be the target, and must appear in the target's live `parentSession` chain. Unlike `interrupt`, a missing live target is an error (`NOT_LIVE`), not an accepted no-op, because the caller asked to change something that is not running. `interrupt` keeps its wider `SubagentControlAuthority` (a human parent address or a live ancestor); reassignment deliberately has no human-address path because no surface presents one, and the cost of a wrong switch (provider sees the child's context) is higher than the cost of a wrong stop.

The tool resolves `provider`/`model`/`reasoning_effort` through `ctx.llm.resolveCallConfig` before installing anything, so an unknown provider, model, or unsupported effort fails the tool call instead of becoming the child's next failed request. `tool-subagent-control` therefore injects `llm` in addition to `tools` and `subagents`.

## Alternatives considered

- **Automatic fallback chain.** A configured ordered list of routes that `llm-retry` advances on quota errors would fix the unattended case, including a foreground subagent whose parent is blocked awaiting it. Deferred: it needs an evidence-backed default list per provider, a durable record of which route a session used, and a decision about whether a fallback crosses providers (different tool schemas, cache prefixes, and pricing). A manual switch is the smaller change that answers the reported problem today.
- **Persist the override in the durable descriptor.** This would survive cold resume and process restart. Deferred: the descriptor is versioned (`SUBAGENT_DESCRIPTOR_VERSION`) and currently records the creation route; changing what a resume composes requires an explicit format decision.
- **Allow the user address for reassignment.** Rejected for now as a surface with no consumer: the API gateway rejects subagent sessions, so a human client cannot reach a child's session.
- **Support out-of-process children.** Rejected as unavailable rather than deferred work: an ACP/Codex/Claude Code child has no local `Agent`, so there is no `agent/request` listener to install and no live lineage to authorize against. Those children report `NOT_LIVE`.

## Consequences

- A stuck session can be moved to another route without cancelling the turn, from the existing model picker (main session) or by asking the agent to call `set_agent_model` (live child).
- The reassignment is process-local and lasts until the child `Agent` is disposed. A continuable child that goes idle and is cold-resumed composes its descriptor's creation route again; the service README records this limitation, and durable persistence is the follow-up named above.
- `set_agent_model` cannot help when the caller is the parent blocked in a foreground delegation; only an automatic fallback (or a cancel-and-retry) covers that case.
- The underlying classification is unchanged: a terminal quota exhaustion that a provider reports as retryable `RATE_LIMIT` is still retried under the adapter's policy until the step is cancelled or the route is switched. Automatic fallback and better terminal-quota classification remain open.
