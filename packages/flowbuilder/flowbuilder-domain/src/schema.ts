/**
 * Zod schemas for the flowbuilder durable boundary. Each schema validates the
 * exact record the storage domain persists and the wire layer re-exports for
 * request validation; the branded id fields go through string transforms (a
 * brand has no runtime representation).
 *
 * @module @deepseek-ai/dsh-flowbuilder-domain/schema
 */

import { z } from 'zod'
import { BlockId, FlowId, FlowRunId } from './types.ts'

/** The data type one port carries. */
export const flowPortType = z.enum(['any', 'string', 'number', 'json'])

/** How a node executes. */
export const flowNodeKind = z.enum([
  'input',
  'output',
  'code',
  'llm',
  'agent',
  'shell',
  'http',
  'condition',
  'transform',
  'library',
])

/** The executable node kinds a library entry may store. */
export const blockKind = z.enum(['code', 'llm', 'agent', 'shell', 'http', 'condition', 'transform'])

/** Parameter values a node carries (JSON data only). */
export const flowParamValue = z.union([z.string(), z.number(), z.boolean(), z.null()])

/** One typed port declaration. */
export const flowPortSchema = z.object({
  name: z.string().min(1),
  type: flowPortType,
  description: z.string().optional(),
})

/** One configurable parameter declaration. */
export const flowParamSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'json']),
  required: z.boolean().optional(),
  default: flowParamValue.optional(),
  description: z.string().optional(),
})

/** One node of a flow graph. */
export const flowNodeSchema = z.object({
  id: z.string().min(1),
  kind: flowNodeKind,
  blockId: z.string().optional(),
  title: z.string().min(1),
  params: z.record(z.string(), flowParamValue).default({}),
  code: z.string().optional(),
  x: z.number().default(0),
  y: z.number().default(0),
})

/** One directed data edge between two node ports. */
export const flowEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.object({ nodeId: z.string().min(1), port: z.string().min(1) }),
  to: z.object({ nodeId: z.string().min(1), port: z.string().min(1) }),
})

/** One stored workflow definition. */
export const flowDefinitionSchema = z.object({
  id: z.string().transform(FlowId),
  name: z.string().min(1),
  description: z.string(),
  nodes: z.array(flowNodeSchema),
  edges: z.array(flowEdgeSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored reusable block. */
export const blockLibraryEntrySchema = z.object({
  id: z.string().transform(BlockId),
  name: z.string().min(1),
  kind: blockKind,
  description: z.string(),
  code: z.string().optional(),
  inputs: z.array(flowPortSchema),
  outputs: z.array(flowPortSchema),
  params: z.array(flowParamSchema),
  sourceFlowId: z.string().optional(),
  createdAt: z.string(),
}).strict()

/** One node's settlement inside a run record. */
export const flowNodeRunStateSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'error', 'skipped']),
  output: z.unknown().optional(),
  error: z.string().optional(),
})

/** One stored run record. */
export const flowRunRecordSchema = z.object({
  id: z.string().transform(FlowRunId),
  flowId: z.string().transform(FlowId),
  status: z.enum(['running', 'completed', 'error', 'cancelled']),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  nodes: z.record(z.string(), flowNodeRunStateSchema),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

/**
 * Save-request for one workflow definition. The id is optional (the service
 * mints one); timestamps are always service-owned, never client-supplied.
 */
export const flowSaveRequestSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string(),
  nodes: z.array(flowNodeSchema),
  edges: z.array(flowEdgeSchema),
})

/**
 * Save-request for one library block. The id and creation timestamp are
 * service-owned; `sourceFlowId` identifies the flow a client extracted the block from.
 * A `code` block carries its code at save time — an empty code body is a
 * caller bug, rejected at the durable boundary.
 */
export const blockSaveRequestSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  kind: blockKind,
  description: z.string(),
  code: z.string().optional(),
  inputs: z.array(flowPortSchema),
  outputs: z.array(flowPortSchema),
  params: z.array(flowParamSchema),
  sourceFlowId: z.string().optional(),
}).refine(
  request => request.kind !== 'code' || (request.code !== undefined && request.code.trim().length > 0),
  { message: 'a code block carries no code' },
)

/**
 * Save-request for one workflow definition, inferred from
 * {@link flowSaveRequestSchema}.
 */
export type FlowSaveRequest = z.input<typeof flowSaveRequestSchema>
/** Save-request for one library block, inferred from {@link blockSaveRequestSchema}. */
export type BlockSaveRequest = z.input<typeof blockSaveRequestSchema>

/** One stored workflow definition, inferred from {@link flowDefinitionSchema}. */
export type FlowDefinitionRecord = z.infer<typeof flowDefinitionSchema>
/** One stored reusable block, inferred from {@link blockLibraryEntrySchema}. */
export type BlockLibraryEntryRecord = z.infer<typeof blockLibraryEntrySchema>
/** One stored run record, inferred from {@link flowRunRecordSchema}. */
export type FlowRunRecordRecord = z.infer<typeof flowRunRecordSchema>
