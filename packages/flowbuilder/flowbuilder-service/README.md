# @deepseek-ai/dsh-flowbuilder-service

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

- **Executor coverage is partial** — `input`, `output`, `transform`, `code`, `condition` (both on the workspace code runtime, programs reading plain `inputs`/`params` objects), and `library` nodes execute; `llm`, `http`, `shell`, and `agent` nodes fail the run loudly (`no executor in this build`) until their executors land.
- **Code nodes need the code runtime** — a composition without `ctx.codeRuntime` fails code and condition nodes loudly; the run record carries the message.
- **Library identity is name-or-id** — a save without `id` replaces the same-name entry (the model's iterate path); renaming mints a new entry. Versioned blocks and folders are deferred with the domain's library limitations.
