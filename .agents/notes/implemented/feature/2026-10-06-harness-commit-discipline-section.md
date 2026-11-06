# Agent Note: Harness commit-discipline prompt section

Status: implemented

English

## Problem

The user had to request commits explicitly ("feature commits for all the outstanding code") after finished work. Nothing in the assembled prompt owned the rule; repo-level `AGENTS.md` conventions reach only agents working inside this repository, while the harness prompt reaches every session in every project.

## Decision

`@deepseek-ai/dsh-system-prompt` registers `harness:commit-discipline` (order −99) in every assembly, directly after `harness:identity`. The section is a standing instruction: commit each verified fix or feature immediately with a deliberate conventional message, never end a turn with finished verified work uncommitted, survey the tree and group unrelated pending changes into logical feature commits, and keep commits atomic. The section is always on — no config flag — because the behavior is the harness's own workflow contract, not a deployment-varying choice. A scoped section of the same name shadows it where an agent preset replaces the default, the same shadowing the persona slot uses.

## Consequences

- Every model request now carries the section, so every deployment's keyless prompt snapshots (headless, ACP, SDK, web round-trip) changed; all 29 affected expected fixtures were updated in the same change, plus the SDK scenario's inline `expectedSystem`, now composed from the exported `TODO_TREE_DISCIPLINE` / `TOKEN_EFFICIENCY` / `PLUGIN_DISCIPLINE` constants of `@deepseek-ai/dsh-tools` instead of a stale partial string.
- The snapshot replay suite still fails on failures that pre-date this change (old `todo_write` tree schema, `subagent` tool descriptions without `model`/`reasoningEffort`, missing `subagent:delegation` runtime context, missing `cordis_inspect_self` capabilities, tool_search skill gating, badge copy) — each verified to fail identically with this change stashed. Re-recording with a live key is the sanctioned fix and stays outstanding.

## Verification

`packages/core/system-prompt` specs pin the section text verbatim, its order between identity and persona, its presence when the identity is omitted, and the rendered prompt; `pnpm run test:snapshot` covers the assembled applications keylessly.

## Alternatives considered

**Rely only on repository AGENTS.md instructions.** Rejected: those rules reach agents in this repository, not every Harness session. The shared prompt owns the cross-project workflow instruction.
