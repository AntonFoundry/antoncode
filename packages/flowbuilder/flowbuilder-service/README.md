---
description: "flowbuilder-service package."
kind: "package-reference"
---

# @deepseek-ai/dsh-flowbuilder-service

## Summary

English

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)

## Understand the implementation

English

The flowbuilder capability seam: the injectable `ctx.flowBuilder` service — the durable store for workflow definitions and the reusable block library over the `flowbuilder` storage domain, plus the wave scheduler that executes saved graphs into durable run records — and the `flowbuilder/flow-changed`, `flowbuilder/library-changed`, and `flowbuilder/run-*` lifecycle events.

Graph well-formedness (unique ids, resolvable edges, one edge per input port, acyclicity) is enforced at every save by [`validateFlowStructure`](../flowbuilder-domain/README.md); a rejected save writes nothing.

## Model Experience

### Durable workflow definitions and block library

#### What the model sees

The `flow.*` tool family (mounted per agent preset) reads and writes through this service: saving a workflow or authoring a block persists it across restarts, `flow_run` executes a saved graph, and each write or run transition emits a `flowbuilder/*` event the canvas and tools observe. The service registers no tools and injects no prompts itself.

#### Token effect

Only the tools' inputs and results (flow graphs and library entries the model explicitly saves or requests). The service injects nothing into request prefixes.

#### KV Cache effect

Independent: writes land in the storage domain, never in a session log, so nothing here invalidates provider cache reuse.

## Known Limitations and Deferred Work

- **`agent` nodes need the spawn face** — an `agent` node fails the run loudly until an executor bridges the subagent spawn provider (a run outside an agent turn has no parent to attribute children to); every other kind executes.
- **Executor service availability is loud** — code/condition nodes need `ctx.codeRuntime`, llm nodes `ctx.llm`, http nodes `ctx.web`, shell nodes `ctx.shell`; a composition missing one fails those nodes with a message naming the service.
- **Library identity is name-or-id** — a save without `id` replaces the same-name entry (the model's iterate path); renaming mints a new entry. Versioned blocks and folders are deferred with the domain's library limitations.

## Dev Note

- See the module JSDoc for the owning contract and its rationale.
