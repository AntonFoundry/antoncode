/**
 * Flowbuilder durable vocabulary: flow definitions, block library entries,
 * run records, zod schemas, DAG validation, and the flowbuilder storage
 * domain spec.
 * @module @deepseek-ai/dsh-flowbuilder-domain
 */

export {
  BlockId,
  FlowId,
  FlowRunId,
} from './types.ts'
export type {
  BlockKind,
  BlockLibraryEntry,
  FlowDefinition,
  FlowEdge,
  FlowNode,
  FlowNodeKind,
  FlowNodeRunState,
  FlowNodeRunStatus,
  FlowParam,
  FlowPort,
  FlowPortType,
  FlowRunRecord,
  FlowRunStatus,
} from './types.ts'
export {
  blockKind,
  blockLibraryEntrySchema,
  flowDefinitionSchema,
  flowEdgeSchema,
  flowNodeKind,
  flowNodeRunStateSchema,
  flowNodeSchema,
  flowParamSchema,
  flowPortSchema,
  flowPortType,
  flowRunRecordSchema,
  flowSaveRequestSchema,
  blockSaveRequestSchema,
} from './schema.ts'
export type {
  BlockLibraryEntryRecord,
  FlowDefinitionRecord,
  FlowRunRecordRecord,
  FlowSaveRequest,
  BlockSaveRequest,
} from './schema.ts'
export { flowbuilderDomainSpec, flowbuilderDomainState } from './spec.ts'
export type { FlowbuilderDomainState } from './spec.ts'
export { validateFlowStructure } from './dag.ts'
export type { DagValidation } from './dag.ts'
