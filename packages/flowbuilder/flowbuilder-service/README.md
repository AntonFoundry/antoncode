# @deepseek-ai/dsh-flowbuilder-service

English

The flowbuilder capability seam: the injectable `ctx.flowBuilder` service — the durable store for workflow definitions and the reusable block library over the `flowbuilder` storage domain — plus the `flowbuilder/flow-changed` and `flowbuilder/library-changed` lifecycle events.

Graph well-formedness (unique ids, resolvable edges, one edge per input port, acyclicity) is enforced at every save by [`validateFlowStructure`](../flowbuilder-domain/README.md); a rejected save writes nothing.

## Model Experience

### Durable workflow definitions and block library

#### What the model sees

The `flow.*` tool family (mounted per agent preset) reads and writes through this service: saving a workflow or authoring a block persists it across restarts, and each write emits a `flowbuilder/*` event the canvas and tools observe. The service registers no tools and injects no prompts itself.

#### Token effect

Only the tools' inputs and results (flow graphs and library entries the model explicitly saves or requests). The service injects nothing into request prefixes.

#### KV Cache effect

Independent: writes land in the storage domain, never in a session log, so nothing here invalidates provider cache reuse.

## Known Limitations and Deferred Work

- **Runs are not implemented yet** — run records and the execution scheduler land with the flowbuilder engine; this package currently owns definitions and the library only.
- **Library identity is name-or-id** — a save without `id` replaces the same-name entry (the model's iterate path); renaming mints a new entry. Versioned blocks and folders are deferred with the domain's library limitations.
