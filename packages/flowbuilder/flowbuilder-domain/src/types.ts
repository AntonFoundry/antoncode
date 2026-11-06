/**
 * Flowbuilder vocabulary: the cross-boundary ids and the graph data types a
 * flow definition, block library entry, and run record carry. Types only per
 * the package convention — the zod schemas in `schema.ts` are the durable
 * boundary validators and the direct source of the wire projection.
 *
 * @module @deepseek-ai/dsh-flowbuilder-domain/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one stored workflow definition. */
export type FlowId = Branded<'FlowId'>

/**
 * Brand a string as a {@link FlowId}.
 * @param id - the raw id string (the service mints UUIDs; tests may pass fixtures).
 * @returns the same string, branded.
 */
export function FlowId(id: string): FlowId {
  return id as FlowId
}

/** Identifies one block library entry. */
export type BlockId = Branded<'BlockId'>

/**
 * Brand a string as a {@link BlockId}.
 * @param id - the raw id string (the service mints UUIDs; tests may pass fixtures).
 * @returns the same string, branded.
 */
export function BlockId(id: string): BlockId {
  return id as BlockId
}

/** Identifies one workflow run. */
export type FlowRunId = Branded<'FlowRunId'>

/**
 * Brand a string as a {@link FlowRunId}.
 * @param id - the raw id string (the service mints UUIDs; tests may pass fixtures).
 * @returns the same string, branded.
 */
export function FlowRunId(id: string): FlowRunId {
  return id as FlowRunId
}

/**
 * The data type one port carries. Closed union — the canvas colors ports by
 * it and executors use it for coercion hints only, never for enforcement
 * (values at runtime are JSON data; `json` is the honest default).
 */
export type FlowPortType = 'any' | 'string' | 'number' | 'json'

/**
 * How a node executes. Closed union (service-owned, consumers may exhaust):
 * `input` seeds the run payload, `output` collects the run result,
 * `code` runs inline JavaScript, `llm` calls the model, `agent` spawns a
 * subagent, `shell` runs a command through the shell capability,
 * `http` performs a fetch, `condition` branches the schedule, `transform`
 * maps its input payload, and `library` instantiates a stored
 * {@link BlockLibraryEntry}.
 */
export type FlowNodeKind =
  | 'input'
  | 'output'
  | 'code'
  | 'llm'
  | 'agent'
  | 'shell'
  | 'http'
  | 'condition'
  | 'transform'
  | 'library'

/** The executable node kinds a library entry may store (graph-plumbing kinds excluded). */
export type BlockKind = Exclude<FlowNodeKind, 'input' | 'output' | 'library'>

/** One typed port declaration (a library entry's inputs/outputs). */
export interface FlowPort {
  /** Port name; an edge references it verbatim. */
  name: string
  /** The declared data type (rendering and coercion hints only). */
  type: FlowPortType
  /** Optional one-line description shown in the inspector. */
  description?: string | undefined
}

/** One configurable parameter declaration (a library entry's schema). */
export interface FlowParam {
  /** Parameter name; node params reference it verbatim. */
  name: string
  /** The value form this parameter accepts. */
  type: 'string' | 'number' | 'boolean' | 'json'
  /** Whether the executor refuses to run the node without a value. */
  required?: boolean | undefined
  /** The value used when the node params omit it. */
  default?: string | number | boolean | null | undefined
  /** Optional one-line description shown in the inspector. */
  description?: string | undefined
}

/**
 * One node of a flow graph. Node ids are flow-internal plain strings (they
 * live only inside the definition JSON and never cross a package boundary on
 * their own, so they carry no brand).
 */
export interface FlowNode {
  /** Unique within the definition. */
  id: string
  /** How the node executes. */
  kind: FlowNodeKind
  /** The {@link BlockLibraryEntry} id; present exactly when `kind` is `'library'`. */
  blockId?: string | undefined
  /** Human-facing canvas label. */
  title: string
  /** Parameter values keyed by the block's {@link FlowParam} names. */
  params: Record<string, string | number | boolean | null>
  /** Inline JavaScript for `code` nodes (and the editable override a library instance may carry). */
  code?: string | undefined
  /** Canvas x position. */
  x: number
  /** Canvas y position. */
  y: number
}

/** One directed data edge between two node ports. */
export interface FlowEdge {
  /** Unique within the definition. */
  id: string
  /** Source endpoint. */
  from: { nodeId: string; port: string }
  /** Target endpoint (each target port accepts at most one edge). */
  to: { nodeId: string; port: string }
}

/** One stored workflow definition. Timestamps are ISO-8601 strings. */
export interface FlowDefinition {
  id: FlowId
  name: string
  description: string
  nodes: FlowNode[]
  edges: FlowEdge[]
  createdAt: string
  updatedAt: string
}

/** One stored reusable block. Authored once (by the model or a flow save), instantiated by `library` nodes. */
export interface BlockLibraryEntry {
  id: BlockId
  /** Display name (unique in the library; saves overwrite by name match). */
  name: string
  /** How an instance executes. */
  kind: BlockKind
  /** One-line description surfaced in search results and the palette. */
  description: string
  /** The block's JavaScript (required for `code`; optional elsewhere). */
  code?: string | undefined
  /** Declared input ports. */
  inputs: FlowPort[]
  /** Declared output ports. */
  outputs: FlowPort[]
  /** Declared parameters. */
  params: FlowParam[]
  /** The flow the block was extracted from, when it has one. */
  sourceFlowId?: string | undefined
  /** ISO-8601 creation timestamp. */
  createdAt: string
}

/** Why a run settled. Closed union: `completed` reached every sink, `error` hit a node failure, `cancelled` was caller-cancelled. */
export type FlowRunStatus = 'running' | 'completed' | 'error' | 'cancelled'

/** One node's lifecycle within a run. `skipped` = an upstream branch pruned it. */
export type FlowNodeRunStatus = 'pending' | 'running' | 'completed' | 'error' | 'skipped'

/** One node's settlement inside a run record. */
export interface FlowNodeRunState {
  /** Where the node settled (or stands, while the run is live). */
  status: FlowNodeRunStatus
  /** The node's JSON output value, once completed. */
  output?: unknown
  /** The failure message, once errored. */
  error?: string | undefined
}

/** One stored run record. The canvas run overlay and `flow.runGet` read this. */
export interface FlowRunRecord {
  id: FlowRunId
  flowId: FlowId
  status: FlowRunStatus
  startedAt: string
  finishedAt?: string | undefined
  /** Per-node state keyed by node id. */
  nodes: Record<string, FlowNodeRunState>
  /** The output sink's collected value, once completed. */
  result: unknown
  /** The run-level failure message, once errored. */
  error?: string | undefined
}
