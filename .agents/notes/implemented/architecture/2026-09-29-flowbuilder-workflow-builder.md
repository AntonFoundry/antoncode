# Agent Note: flowbuilder — durable workflow definitions and the block library behind `ctx.flowBuilder`

Status: implemented

The canvas presentation is superseded by [the LangFlow integration](../feature/2026-09-30-langflow-sidecar-workflows-tab.md); the domain, service, and tool ownership remains.

English

## Problem

The Dag Flow canvas tab is a read-only projection of session runs — a workflow the user describes in chat has no durable existence, no editable graph, and no reusable parts. Replacing it with a real builder needs a backend that owns workflow definitions as data: the model must author a workflow in chat, the canvas must render and edit it, and both must read the same store.

## Decision

New capability family `packages/flowbuilder/` with two packages so far:

- **`dsh-flowbuilder-domain`** owns the durable vocabulary: `FlowId`/`BlockId`/`FlowRunId` brands, the record schemas (definitions, library entries, run records) as zod, save-request schemas (id/timestamps service-owned), the `flowbuilder` storage domain spec, and `validateFlowStructure` — pure graph validation (unique ids, resolvable endpoints, one edge per input port, `blockId` exactly on `library` nodes, Kahn's-algorithm cycle rejection) that every save path calls so an invalid graph never persists.
- **`dsh-flowbuilder-service`** provides `ctx.flowBuilder` over `ctx.storageDomain` (json backend, `$DSH_HOME/storages` routing): save/get/list/delete for definitions (upsert preserves `createdAt`, bumps `updatedAt`), the block library (a save without id replaces the same-name entry — the model's iterate path), and the `flowbuilder/flow-changed` + `flowbuilder/library-changed` events emitted only after durability. Service errors extend `HarnessError` (`FLOW_GRAPH_INVALID`, `FLOW_NOT_FOUND`, `BLOCK_NOT_FOUND`) so tools, wire, and canvas share one rejection vocabulary.

**`dsh-tool-flowbuilder`** is the chat→workflow recognition path: `flow_list`/`flow_get`/`flow_save`/`flow_library_search`/`flow_block_save` plus a prompt section (order 116) that instructs the authoring loop — search the library, author small blocks, save the workflow, tell the user it is on the Dag Flow canvas. Node `params`/`x`/`y` default at the zod schema, so a model-authored minimal node parses unchanged. Records spread optional fields conditionally: an explicit `undefined`-valued key fails the tool registry's lossless-JSON output check, so the service never publishes one.

Storage mounts as a host-plane row; the tools mount per agent preset (agent-plane), following the tool-bash precedent — the store is session-independent state, the tools are per-session catalog entries.

## Alternatives considered

A single mega-package (domain + service + tools) was rejected: the domain's schemas are consumed by the apiproxy wire layer and the client canvas without pulling the service. Session-event storage (goal-style fold) was rejected: workflows are user-owned artifacts edited outside any one session, not per-session projections. Hand-rolled file persistence under `storages/flowbuilder/` was rejected in favor of the storage domain form: validation, durability ordering, and `domain/changed` come for free and stay consistent with workspace records.

## Consequences

Workflow definitions and library blocks survive restarts and are readable by every consumer of `ctx.flowBuilder`. The remaining plan phases build on this seam: the execution engine (scheduler + node executors, run records, `flowbuilder/run-*` events), the `flow.*` apiproxy domain, and the `ui-flowbuilder` canvas. `flow_run`/`flow_run_status` tools are deliberately absent until the engine lands.

## Verification

`npx vitest run packages/flowbuilder` (42 tests): DAG validation (structure, fan-out vs duplicate-in, cycles), schema round trips, service store behavior over a real json backend including a restart round trip, the scheduler (linear chains, concurrent branches, condition pruning, error propagation with downstream skips, library indirection, unknown kinds), run-event pairing invariants, real-stack runs to a durable terminal record, and the seven tools driven through `ctx.tools.execute` — plus a real Loader composition (`tests/loader-composition.spec.ts`) booting storage→service→tools→plugin from a cordis.yml and saving a workflow end to end. `npx tsc -b` per package and the staged lint gate are clean.
