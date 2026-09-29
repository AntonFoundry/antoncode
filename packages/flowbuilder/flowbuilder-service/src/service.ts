/**
 * Flowbuilder Service Definition: `ctx.flowBuilder` — the durable store for
 * workflow definitions and the reusable block library, plus the
 * `flowbuilder/*` change events observers (tools, wire, canvas) subscribe to.
 * Invalid requests throw before any write; a save either lands whole or
 * leaves the domain untouched.
 * @module @deepseek-ai/dsh-flowbuilder-service
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  BlockId,
  FlowId,
  FlowRunId,
  blockSaveRequestSchema,
  flowSaveRequestSchema,
  flowbuilderDomainSpec,
  validateFlowStructure,
} from '@deepseek-ai/dsh-flowbuilder-domain'
import type {
  BlockLibraryEntryRecord,
  BlockSaveRequest,
  FlowDefinitionRecord,
  FlowNodeRunState,
  FlowRunRecordRecord,
  FlowSaveRequest,
  FlowbuilderDomainState,
} from '@deepseek-ai/dsh-flowbuilder-domain'
import type { CodeJsonValue, CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import { executeRun } from './engine.ts'
import type { RunHost } from './engine.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    flowBuilder: FlowBuilderService
  }

  interface Events {
    /**
     * A workflow definition was saved or deleted. Paired per write; `flow`
     * is the exact stored record (for `deleted`, the record as it was
     * removed).
     * @param action - which write happened.
     * @param flow - the affected definition record.
     * @mode emit
     */
    'flowbuilder/flow-changed'(action: 'saved' | 'deleted', flow: FlowDefinitionRecord): void
    /**
     * A block library entry was saved or deleted. Paired per write; `block`
     * is the exact stored record (for `deleted`, the record as it was
     * removed).
     * @param action - which write happened.
     * @param block - the affected library entry.
     * @mode emit
     */
    'flowbuilder/library-changed'(action: 'saved' | 'deleted', block: BlockLibraryEntryRecord): void
    /**
     * A run started: the durable `running` record as stored.
     * @param record - the run record at start.
     * @mode emit
     */
    'flowbuilder/run-start'(record: FlowRunRecordRecord): void
    /**
     * One node settled into a new state, after that state is durable.
     * @param runId - the owning run.
     * @param nodeId - the node that transitioned.
     * @param state - the node's new state.
     * @mode emit
     */
    'flowbuilder/run-node'(runId: FlowRunId, nodeId: string, state: FlowNodeRunState): void
    /**
     * A run reached its terminal record (emitted exactly once per run).
     * @param record - the terminal record as stored.
     * @mode emit
     */
    'flowbuilder/run-end'(record: FlowRunRecordRecord): void
  }
}

/** A save carried a structurally invalid graph (duplicate ids, dangling edge, or a cycle). */
export class FlowGraphInvalidError extends HarnessError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'FLOW_GRAPH_INVALID', options)
    this.name = 'FlowGraphInvalidError'
  }
}

/** A flow id named no stored definition. */
export class FlowUnknownError extends HarnessError {
  constructor(flowId: string, options?: ErrorOptions) {
    super(`cannot act on unknown flow '${flowId}'`, 'FLOW_NOT_FOUND', options)
    this.name = 'FlowUnknownError'
  }
}

/** A block id named no library entry. */
export class BlockUnknownError extends HarnessError {
  constructor(blockId: string, options?: ErrorOptions) {
    super(`cannot act on unknown block '${blockId}'`, 'BLOCK_NOT_FOUND', options)
    this.name = 'BlockUnknownError'
  }
}

/** A run id named no stored run record. */
export class FlowRunUnknownError extends HarnessError {
  constructor(runId: string, options?: ErrorOptions) {
    super(`cannot act on unknown run '${runId}'`, 'RUN_NOT_FOUND', options)
    this.name = 'FlowRunUnknownError'
  }
}

/**
 * Flowbuilder store contract. Every read is synchronous over the opened
 * domain's in-memory state; every write validates at the durable boundary,
 * lands atomically on the domain's per-table write chain, and emits the
 * matching `flowbuilder/*` event only after durability.
 */
export class FlowBuilderService extends Service {
  /** The domain facility must exist before the store can open. */
  static inject = ['storageDomain']

  private flows?: KvTable<FlowId, FlowDefinitionRecord>
  private library?: KvTable<BlockId, BlockLibraryEntryRecord>
  private runs?: KvTable<FlowRunId, FlowRunRecordRecord>

  constructor(ctx: Context) {
    super(ctx, 'flowBuilder')
  }

  /** Open the flowbuilder domain and wire the store tables. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(flowbuilderDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'flowbuilder.domainClose')
    this.flows = domain.table('flows')
    this.library = domain.table('library')
    this.runs = domain.table('runs')
    const global = domain.global as DomainGlobal<FlowbuilderDomainState>
    if (!global.get().initialized) await global.set({ initialized: true })
  }

  /**
   * Snapshot every stored workflow definition (domain order: insertion).
   * @returns the stored definitions.
   */
  listFlows(): FlowDefinitionRecord[] {
    return [...this.requireFlows().entries()].map(([, record]) => record)
  }

  /**
   * Read one stored workflow definition.
   * @param flowId - the definition id.
   * @returns the record, or `undefined` when absent.
   */
  getFlow(flowId: string): FlowDefinitionRecord | undefined {
    return this.requireFlows().get(FlowId(flowId))
  }

  /**
   * Validate and upsert one workflow definition. Absent `id`, a new
   * definition is minted; present `id`, the stored record is replaced whole
   * (creation time preserved, update time bumped). The graph must be
   * structurally valid and acyclic — see `validateFlowStructure`.
   * @param request - the save request (id optional).
   * @returns the exact record stored.
   */
  async saveFlow(request: FlowSaveRequest): Promise<FlowDefinitionRecord> {
    const parsed = flowSaveRequestSchema.parse(request)
    const validation = validateFlowStructure(parsed.nodes, parsed.edges)
    if (!validation.ok) throw new FlowGraphInvalidError(validation.error ?? 'invalid flow graph')
    const now = new Date().toISOString()
    const existing = parsed.id === undefined ? undefined : this.requireFlows().get(FlowId(parsed.id))
    const record: FlowDefinitionRecord = {
      id: FlowId(existing?.id ?? parsed.id ?? randomUUID()),
      name: parsed.name,
      description: parsed.description,
      nodes: parsed.nodes,
      edges: parsed.edges,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.requireFlows().put(record.id, record)
    this.ctx.emit('flowbuilder/flow-changed', 'saved', record)
    return record
  }

  /**
   * Delete one stored workflow definition.
   * @param flowId - the definition id.
   * @returns the record as it was removed.
   * @throws {@link FlowUnknownError} when the id names no stored definition.
   */
  async deleteFlow(flowId: string): Promise<FlowDefinitionRecord> {
    const table = this.requireFlows()
    const existing = table.get(FlowId(flowId))
    if (existing === undefined) throw new FlowUnknownError(flowId)
    await table.delete(existing.id)
    this.ctx.emit('flowbuilder/flow-changed', 'deleted', existing)
    return existing
  }

  /**
   * Snapshot the block library, optionally filtered by a case-insensitive
   * substring over name and description.
   * @param query - the filter substring (omit for everything).
   * @returns the matching entries.
   */
  listBlocks(query?: string): BlockLibraryEntryRecord[] {
    const all = [...this.requireLibrary().entries()].map(([, entry]) => entry)
    if (query === undefined || query.length === 0) return all
    const needle = query.toLowerCase()
    return all.filter(entry =>
      entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle),
    )
  }

  /**
   * Read one stored library block.
   * @param blockId - the entry id.
   * @returns the entry, or `undefined` when absent.
   */
  getBlock(blockId: string): BlockLibraryEntryRecord | undefined {
    return this.requireLibrary().get(BlockId(blockId))
  }

  /**
   * Validate and upsert one library block. Absent `id`, a block with the
   * same display name (case-sensitive) is replaced whole — authoring by name
   * is the model's iterate path — otherwise a new entry is minted.
   * @param request - the save request (id optional).
   * @returns the exact entry stored.
   */
  async saveBlock(request: BlockSaveRequest): Promise<BlockLibraryEntryRecord> {
    const parsed = blockSaveRequestSchema.parse(request)
    const now = new Date().toISOString()
    const table = this.requireLibrary()
    const existingById = parsed.id === undefined ? undefined : table.get(BlockId(parsed.id))
    const existingByName = existingById === undefined
      ? [...table.entries()].find(([, entry]) => entry.name === parsed.name)?.[1]
      : undefined
    const existing = existingById ?? existingByName
    // Optional fields spread conditionally: a record with explicit
    // `undefined`-valued keys is not lossless JSON at the tool/wire boundary.
    const provenance: BlockLibraryEntryRecord['provenance'] = {
      createdAt: existing?.provenance.createdAt ?? now,
    }
    const sourceFlowId = parsed.sourceFlowId ?? existing?.provenance.sourceFlowId
    if (sourceFlowId !== undefined) provenance.sourceFlowId = sourceFlowId
    const record: BlockLibraryEntryRecord = {
      id: BlockId(existing?.id ?? parsed.id ?? randomUUID()),
      name: parsed.name,
      kind: parsed.kind,
      description: parsed.description,
      inputs: parsed.inputs,
      outputs: parsed.outputs,
      params: parsed.params,
      provenance,
    }
    if (parsed.code !== undefined) record.code = parsed.code
    await table.put(record.id, record)
    this.ctx.emit('flowbuilder/library-changed', 'saved', record)
    return record
  }

  /**
   * Delete one stored library block.
   * @param blockId - the entry id.
   * @returns the entry as it was removed.
   * @throws {@link BlockUnknownError} when the id names no stored entry.
   */
  async deleteBlock(blockId: string): Promise<BlockLibraryEntryRecord> {
    const table = this.requireLibrary()
    const existing = table.get(BlockId(blockId))
    if (existing === undefined) throw new BlockUnknownError(blockId)
    await table.delete(existing.id)
    this.ctx.emit('flowbuilder/library-changed', 'deleted', existing)
    return existing
  }

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
  async runFlow(flowId: string, options: { signal?: AbortSignal } = {}): Promise<FlowRunId> {
    const flow = this.getFlow(flowId)
    if (flow === undefined) throw new FlowUnknownError(flowId)
    const validation = validateFlowStructure(flow.nodes, flow.edges)
    if (!validation.ok) throw new FlowGraphInvalidError(validation.error ?? 'invalid flow graph')
    const started: FlowRunRecordRecord = {
      id: FlowRunId(randomUUID()),
      flowId: flow.id,
      status: 'running',
      startedAt: new Date().toISOString(),
      nodes: Object.fromEntries(flow.nodes.map(node => [node.id, { status: 'pending' as const }])),
    }
    await this.requireRuns().put(started.id, started)
    this.ctx.emit('flowbuilder/run-start', started)
    void executeRun(this.runHost(), flow, started, options.signal)
      .then((terminal) => { this.ctx.emit('flowbuilder/run-end', terminal) })
      .catch(() => { /* executeRun never rejects: it persists its own terminal error record. */ })
    return started.id
  }

  /**
   * Read one run record.
   * @param runId - the run id.
   * @returns the record, or `undefined` when absent.
   */
  getRun(runId: string): FlowRunRecordRecord | undefined {
    return this.requireRuns().get(FlowRunId(runId))
  }

  /**
   * Snapshot run records, newest first, optionally scoped to one flow.
   * @param flowId - the definition id to scope to (omit for every run).
   * @returns the matching run records.
   */
  listRuns(flowId?: string): FlowRunRecordRecord[] {
    const all = [...this.requireRuns().entries()].map(([, record]) => record)
    const scoped = flowId === undefined ? all : all.filter(record => record.flowId === FlowId(flowId))
    return scoped.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** The execution seam the scheduler calls; every emission follows its put. */
  private runHost(): RunHost {
    return {
      putRecord: record => this.requireRuns().put(record.id, record),
      onNodeState: (runId, nodeId, state) => { this.ctx.emit('flowbuilder/run-node', runId, nodeId, state) },
      getBlock: blockId => this.getBlock(blockId),
      runCode: (program, params, inputs, signal) => this.runProgram(program, params, inputs, signal),
    }
  }

  /** Run one node program on the workspace code runtime, rejecting on failure. */
  private async runProgram(
    program: string,
    params: Record<string, string | number | boolean | null>,
    inputs: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const runtime = this.ctx.get('codeRuntime') as CodeRuntime | undefined
    if (runtime === undefined) throw new Error('codeRuntime service is not mounted in this composition')
    const result = await runtime.run({
      // The binding face is async (CodeBindingFunction), so the service wraps
      // the program with a prelude: user code reads plain `inputs` / `params`
      // objects instead of awaiting the flow namespace.
      program: `const inputs = await flow.inputs()\nconst params = await flow.params()\n${program}`,
      bindings: [{
        global: 'flow',
        functions: {
          // The engine builds these from JSON-safe record data, so the cast
          // states the lossless-JSON fact the runtime re-checks at the end.
          inputs: (): Promise<CodeJsonValue> => Promise.resolve(inputs as CodeJsonValue),
          params: (): Promise<CodeJsonValue> => Promise.resolve(params as CodeJsonValue),
        },
      }],
      ...signal !== undefined ? { signal } : {},
    })
    if (result.error !== undefined) throw new Error(result.error.message)
    return result.value
  }

  /** The runs table, or a loud caller-bug error when the service has not started. */
  private requireRuns(): KvTable<FlowRunId, FlowRunRecordRecord> {
    if (this.runs === undefined) throw new Error('flowbuilder store is not started yet')
    return this.runs
  }

  /** The flows table, or a loud caller-bug error when the service has not started. */
  private requireFlows(): KvTable<FlowId, FlowDefinitionRecord> {
    if (this.flows === undefined) throw new Error('flowbuilder store is not started yet')
    return this.flows
  }

  /** The library table, or a loud caller-bug error when the service has not started. */
  private requireLibrary(): KvTable<BlockId, BlockLibraryEntryRecord> {
    if (this.library === undefined) throw new Error('flowbuilder store is not started yet')
    return this.library
  }
}

export default FlowBuilderService
