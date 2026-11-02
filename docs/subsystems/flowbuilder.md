# Flowbuilder

English

The flowbuilder seam stores durable workflow definitions and a reusable block library, and executes saved graphs into durable run records. It is the state layer behind the Workflows tab; the [workflow](workflow.md) seam stays the run-a-script execution engine and is untouched by it.

Service Definition: [dsh-flowbuilder-service](../../packages/flowbuilder/flowbuilder-service) (`ctx.flowBuilder`, over the `flowbuilder` storage domain owned by [dsh-flowbuilder-domain](../../packages/flowbuilder/flowbuilder-domain)). The model-facing Consumer is [dsh-tool-flowbuilder](../../packages/flowbuilder/tool-flowbuilder) (the `flow.*` tools). The optional Workflows-tab embed is [dsh-langflow-sidecar](../../packages/flowbuilder/langflow-sidecar) (`ctx.langflow`), which supervises a local LangFlow server the browser reaches through the `langflow.*` RPC routes.

Graph well-formedness (unique ids, resolvable edges, one edge per input port, acyclicity) is enforced at every save by `validateFlowStructure`; a rejected save writes nothing. Reads are synchronous over the opened domain's in-memory state; writes validate at the durable boundary, land atomically on the domain's per-table write chain, and emit the matching `flowbuilder/*` event only after durability. See the package READMEs for the model-facing contract ([service](../../packages/flowbuilder/flowbuilder-service/README.md), [domain](../../packages/flowbuilder/flowbuilder-domain/README.md), [sidecar](../../packages/flowbuilder/langflow-sidecar/README.md), [tools](../../packages/flowbuilder/tool-flowbuilder/README.md)).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxflowbuilder--flowbuilderservice"></a>

### `ctx.flowBuilder` — `FlowBuilderService`

Flowbuilder store contract. Every read is synchronous over the opened domain's in-memory state; every write validates at the durable boundary, lands atomically on the domain's per-table write chain, and emits the matching `flowbuilder/*` event only after durability.

```ts cordis-catalog
/**
 * Snapshot every stored workflow definition (domain order: insertion).
 * @returns the stored definitions.
 */
listFlows(): FlowDefinitionRecord[]

/**
 * Read one stored workflow definition.
 * @param flowId - the definition id.
 * @returns the record, or `undefined` when absent.
 */
getFlow(flowId: string): FlowDefinitionRecord | undefined

/**
 * Validate and upsert one workflow definition. Absent `id`, a new
 * definition is minted; present `id`, the stored record is replaced whole
 * (creation time preserved, update time bumped). The graph must be
 * structurally valid and acyclic — see `validateFlowStructure`.
 * @param request - the save request (id optional).
 * @returns the exact record stored.
 */
async saveFlow(request: FlowSaveRequest): Promise<FlowDefinitionRecord>

/**
 * Delete one stored workflow definition.
 * @param flowId - the definition id.
 * @returns the record as it was removed.
 * @throws {@link FlowUnknownError} when the id names no stored definition.
 */
async deleteFlow(flowId: string): Promise<FlowDefinitionRecord>

/**
 * Snapshot the block library, optionally filtered by a case-insensitive
 * substring over name and description.
 * @param query - the filter substring (omit for everything).
 * @returns the matching entries.
 */
listBlocks(query?: string): BlockLibraryEntryRecord[]

/**
 * Read one stored library block.
 * @param blockId - the entry id.
 * @returns the entry, or `undefined` when absent.
 */
getBlock(blockId: string): BlockLibraryEntryRecord | undefined

/**
 * Validate and upsert one library block. Absent `id`, a block with the
 * same display name (case-sensitive) is replaced whole — authoring by name
 * is the model's iterate path — otherwise a new entry is minted.
 * @param request - the save request (id optional).
 * @returns the exact entry stored.
 */
async saveBlock(request: BlockSaveRequest): Promise<BlockLibraryEntryRecord>

/**
 * Delete one stored library block.
 * @param blockId - the entry id.
 * @returns the entry as it was removed.
 * @throws {@link BlockUnknownError} when the id names no stored entry.
 */
async deleteBlock(blockId: string): Promise<BlockLibraryEntryRecord>

/**
 * Start one run of a saved definition. The record is durable and
 * `flowbuilder/run-start` has fired when this resolves; execution
 * continues asynchronously and settles through `flowbuilder/run-end`.
 * @param flowId - the definition id.
 * @param options - `signal` cancels the run.
 * @returns the run id.
 * @throws {@link FlowUnknownError} when the id names no stored definition.
 * @throws {@link FlowGraphInvalidError} when the stored graph is invalid.
 */
async runFlow(flowId: string, options: { signal?: AbortSignal } = {}): Promise<FlowRunId>

/**
 * Read one run record.
 * @param runId - the run id.
 * @returns the record, or `undefined` when absent.
 */
getRun(runId: string): FlowRunRecordRecord | undefined

/**
 * Snapshot run records, newest first, optionally scoped to one flow.
 * @param flowId - the definition id to scope to (omit for every run).
 * @returns the matching run records.
 */
listRuns(flowId?: string): FlowRunRecordRecord[]
```

Source: [`packages/flowbuilder/flowbuilder-service/src/service.ts:121`](../../packages/flowbuilder/flowbuilder-service/src/service.ts)

<a id="ctxlangflow--langflowsidecar"></a>

### `ctx.langflow` — `LangflowSidecar`

Supervise the embedded LangFlow subprocess: start it for the Workflows tab, report readiness by polling `/health`, and tear it down on dispose.

```ts cordis-catalog
/**
 * Snapshot the current lifecycle state.
 * @returns the status the Workflows tab renders.
 */
status(): LangflowStatus

/**
 * Spawn the child and poll until its HTTP server answers. Idempotent and
 * single-flight: concurrent starts share one attempt, and a start while
 * running returns the current status.
 * @returns the post-start status (`running`, or `error` with the reason).
 */
start(): Promise<LangflowStatus>

/**
 * Terminate the child (SIGTERM → grace → SIGKILL through the subprocess
 * seam) and drop back to `stopped`. Idempotent.
 * @returns when the whole process tree has exited.
 */
async stop(): Promise<void>
```

Source: [`packages/flowbuilder/langflow-sidecar/src/sidecar.ts:56`](../../packages/flowbuilder/langflow-sidecar/src/sidecar.ts)

<a id="flowbuilder-events"></a>

### `flowbuilder/*` events

<a id="flowbuilderflow-changed--emit"></a>

#### `flowbuilder/flow-changed` — emit

A workflow definition was saved or deleted. Paired per write; `flow` is the exact stored record (for `deleted`, the record as it was removed).

```ts cordis-catalog
/**
 * A workflow definition was saved or deleted. Paired per write; `flow`
 * is the exact stored record (for `deleted`, the record as it was
 * removed).
 * @param action - which write happened.
 * @param flow - the affected definition record.
 * @mode emit
 */
'flowbuilder/flow-changed'(action: 'saved' | 'deleted', flow: FlowDefinitionRecord): void
```

Source: [`packages/flowbuilder/flowbuilder-service/src/service.ts:50`](../../packages/flowbuilder/flowbuilder-service/src/service.ts)

<a id="flowbuilderlibrary-changed--emit"></a>

#### `flowbuilder/library-changed` — emit

A block library entry was saved or deleted. Paired per write; `block` is the exact stored record (for `deleted`, the record as it was removed).

```ts cordis-catalog
/**
 * A block library entry was saved or deleted. Paired per write; `block`
 * is the exact stored record (for `deleted`, the record as it was
 * removed).
 * @param action - which write happened.
 * @param block - the affected library entry.
 * @mode emit
 */
'flowbuilder/library-changed'(action: 'saved' | 'deleted', block: BlockLibraryEntryRecord): void
```

Source: [`packages/flowbuilder/flowbuilder-service/src/service.ts:59`](../../packages/flowbuilder/flowbuilder-service/src/service.ts)

<a id="flowbuilderrun-end--emit"></a>

#### `flowbuilder/run-end` — emit

A run reached its terminal record (emitted exactly once per run).

```ts cordis-catalog
/**
 * A run reached its terminal record (emitted exactly once per run).
 * @param record - the terminal record as stored.
 * @mode emit
 */
'flowbuilder/run-end'(record: FlowRunRecordRecord): void
```

Source: [`packages/flowbuilder/flowbuilder-service/src/service.ts:79`](../../packages/flowbuilder/flowbuilder-service/src/service.ts)

<a id="flowbuilderrun-node--emit"></a>

#### `flowbuilder/run-node` — emit

One node settled into a new state, after that state is durable.

```ts cordis-catalog
/**
 * One node settled into a new state, after that state is durable.
 * @param runId - the owning run.
 * @param nodeId - the node that transitioned.
 * @param state - the node's new state.
 * @mode emit
 */
'flowbuilder/run-node'(runId: FlowRunId, nodeId: string, state: FlowNodeRunState): void
```

Source: [`packages/flowbuilder/flowbuilder-service/src/service.ts:73`](../../packages/flowbuilder/flowbuilder-service/src/service.ts)

<a id="flowbuilderrun-start--emit"></a>

#### `flowbuilder/run-start` — emit

A run started: the durable `running` record as stored.

```ts cordis-catalog
/**
 * A run started: the durable `running` record as stored.
 * @param record - the run record at start.
 * @mode emit
 */
'flowbuilder/run-start'(record: FlowRunRecordRecord): void
```

Source: [`packages/flowbuilder/flowbuilder-service/src/service.ts:65`](../../packages/flowbuilder/flowbuilder-service/src/service.ts)
<!-- END GENERATED cordis-surface -->
