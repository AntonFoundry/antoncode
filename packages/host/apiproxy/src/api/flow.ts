/**
 * flow domain contract. The durable workflow-builder projections the Dag Flow
 * canvas reads and edits: workflow definitions, the reusable block library,
 * and run records. Every method mirrors one `ctx.flowBuilder` store operation;
 * the wire shapes are the exact stored records (ids as plain strings).
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One workflow node on the wire (record fields, ids as plain strings). */
export interface FlowNodeWire {
  id: string
  kind: string
  title: string
  blockId?: string
  params: Record<string, unknown>
  code?: string
  x: number
  y: number
}

/** One workflow edge on the wire. */
export interface FlowEdgeWire {
  id: string
  from: { nodeId: string; port: string }
  to: { nodeId: string; port: string }
}

/** One stored workflow definition on the wire. */
export interface FlowWire {
  id: string
  name: string
  description: string
  nodes: FlowNodeWire[]
  edges: FlowEdgeWire[]
  createdAt: string
  updatedAt: string
}

/** One stored library block on the wire. */
export interface BlockWire {
  id: string
  name: string
  kind: string
  description: string
  code?: string
  inputs: { name: string; type: string; description?: string | undefined }[]
  outputs: { name: string; type: string; description?: string | undefined }[]
  params: {
    name: string
    type: string
    required?: boolean | undefined
    default?: string | number | boolean | null | undefined
    description?: string | undefined
  }[]
  provenance: { sourceFlowId?: string | undefined; createdAt: string }
}

/** One run record on the wire (per-node states included). */
export interface FlowRunWire {
  id: string
  flowId: string
  status: 'running' | 'completed' | 'error' | 'cancelled'
  startedAt: string
  finishedAt?: string
  nodes: Record<string, { status: string; output?: unknown; error?: string }>
  result?: unknown
  error?: string
}

/** Save payload for one workflow definition (id optional; timestamps service-owned). */
export interface FlowSavePayload {
  id?: string
  name: string
  description: string
  nodes: FlowNodeWire[]
  edges: FlowEdgeWire[]
}

/** Save payload for one library block (id optional; provenance service-owned). */
export interface BlockSavePayload {
  id?: string
  name: string
  kind: string
  description: string
  code?: string
  inputs: { name: string; type: string; description?: string }[]
  outputs: { name: string; type: string; description?: string }[]
  params: { name: string; type: string; required?: boolean; default?: string | number | boolean | null; description?: string }[]
  sourceFlowId?: string
}

/** flow-domain unary methods (the map keys flow.* of RpcMethodMap). */
export interface FlowApi {
  /** Snapshot every stored workflow definition. */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ flows: FlowWire[] }>>

  /** Read one stored definition; unknown ids fail with `flow-not-found`. */
  get(request: RpcRequest<{ id: string }>): Promise<RpcResponse<{ flow: FlowWire }>>

  /**
   * Validate and upsert one definition (absent id mints one). Invalid graphs
   * (dangling edges, duplicated ids, cycles) fail with `flow-graph-invalid`.
   */
  save(request: RpcRequest<FlowSavePayload>): Promise<RpcResponse<{ flow: FlowWire }>>

  /** Delete one stored definition; unknown ids fail with `flow-not-found`. */
  delete(request: RpcRequest<{ id: string }>): Promise<RpcResponse<{ deleted: true }>>

  /** Start one run; returns the run id once the running record is durable. */
  run(request: RpcRequest<{ flowId: string }>): Promise<RpcResponse<{ runId: string }>>

  /** Snapshot run records, newest first, optionally scoped to one flow. */
  runs(request: RpcRequest<{ flowId?: string }>): Promise<RpcResponse<{ runs: FlowRunWire[] }>>

  /** Read one run record; unknown ids fail with `run-not-found`. */
  runGet(request: RpcRequest<{ runId: string }>): Promise<RpcResponse<{ run: FlowRunWire }>>

  /** Snapshot the block library, optionally filtered by a substring. */
  libraryList(request: RpcRequest<{ query?: string }>): Promise<RpcResponse<{ blocks: BlockWire[] }>>

  /** Validate and upsert one library block (absent id saves by name). */
  librarySave(request: RpcRequest<BlockSavePayload>): Promise<RpcResponse<{ block: BlockWire }>>

  /** Delete one library block; unknown ids fail with `block-not-found`. */
  libraryDelete(request: RpcRequest<{ id: string }>): Promise<RpcResponse<{ deleted: true }>>
}
