/**
 * flow domain zod schemas. The wire record shapes mirror the durable records
 * in `@deepseek-ai/dsh-flowbuilder-domain` with plain-string ids; annotations
 * (not `satisfies`) where branded ids would otherwise be nameable, matching
 * the orchestrator accommodation.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** One workflow node on the wire. */
export const flowNodeWireSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  blockId: z.string().optional(),
  params: z.record(z.string(), z.unknown()),
  code: z.string().optional(),
  x: z.number(),
  y: z.number(),
})

/** One workflow edge on the wire. */
export const flowEdgeWireSchema = z.object({
  id: z.string(),
  from: z.object({ nodeId: z.string(), port: z.string() }),
  to: z.object({ nodeId: z.string(), port: z.string() }),
})

/** One stored workflow definition on the wire. */
export const flowWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  nodes: z.array(flowNodeWireSchema),
  edges: z.array(flowEdgeWireSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored library block on the wire. */
export const blockWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  description: z.string(),
  code: z.string().optional(),
  inputs: z.array(z.object({ name: z.string(), type: z.string(), description: z.string().optional() })),
  outputs: z.array(z.object({ name: z.string(), type: z.string(), description: z.string().optional() })),
  params: z.array(z.object({
    name: z.string(),
    type: z.string(),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    description: z.string().optional(),
  })),
  sourceFlowId: z.string().optional(),
  createdAt: z.string(),
})

/** One run record on the wire. */
export const flowRunWireSchema = z.object({
  id: z.string(),
  flowId: z.string(),
  status: z.enum(['running', 'completed', 'error', 'cancelled']),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  nodes: z.record(z.string(), z.object({
    status: z.string(),
    output: z.unknown().optional(),
    error: z.string().optional(),
  })),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

/** flow.list request payload (empty object literal). */
export const flowListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'flow.list'>>>

/** flow.list response value. */
export const flowListValueSchema: z.ZodType<Wire<ResponseValue<'flow.list'>>> = z.object({
  flows: z.array(flowWireSchema),
})

/** flow.get request payload. */
export const flowGetRequestSchema = z.object({ id: z.string() }) satisfies z.ZodType<Wire<RequestPayload<'flow.get'>>>

/** flow.get response value. */
export const flowGetValueSchema: z.ZodType<Wire<ResponseValue<'flow.get'>>> = z.object({ flow: flowWireSchema })

/** flow.save request payload. */
export const flowSaveRequestSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string(),
  nodes: z.array(flowNodeWireSchema),
  edges: z.array(flowEdgeWireSchema),
}) satisfies z.ZodType<Wire<RequestPayload<'flow.save'>>>

/** flow.save response value. */
export const flowSaveValueSchema: z.ZodType<Wire<ResponseValue<'flow.save'>>> = z.object({ flow: flowWireSchema })

/** flow.delete request payload. */
export const flowDeleteRequestSchema = z.object({ id: z.string() }) satisfies z.ZodType<Wire<RequestPayload<'flow.delete'>>>

/** flow.delete response value. */
export const flowDeleteValueSchema = z.object({ deleted: z.literal(true) }) satisfies z.ZodType<Wire<ResponseValue<'flow.delete'>>>

/** flow.run request payload. */
export const flowRunRequestSchema = z.object({ flowId: z.string() }) satisfies z.ZodType<Wire<RequestPayload<'flow.run'>>>

/** flow.run response value. */
export const flowRunValueSchema = z.object({ runId: z.string() }) satisfies z.ZodType<Wire<ResponseValue<'flow.run'>>>

/** flow.runs request payload. */
export const flowRunsRequestSchema = z.object({ flowId: z.string().optional() }) satisfies z.ZodType<Wire<RequestPayload<'flow.runs'>>>

/** flow.runs response value. */
export const flowRunsValueSchema: z.ZodType<Wire<ResponseValue<'flow.runs'>>> = z.object({ runs: z.array(flowRunWireSchema) })

/** flow.runGet request payload. */
export const flowRunGetRequestSchema = z.object({ runId: z.string() }) satisfies z.ZodType<Wire<RequestPayload<'flow.runGet'>>>

/** flow.runGet response value. */
export const flowRunGetValueSchema: z.ZodType<Wire<ResponseValue<'flow.runGet'>>> = z.object({ run: flowRunWireSchema })

/** flow.libraryList request payload. */
export const flowLibraryListRequestSchema = z.object({ query: z.string().optional() }) satisfies z.ZodType<Wire<RequestPayload<'flow.libraryList'>>>

/** flow.libraryList response value. */
export const flowLibraryListValueSchema: z.ZodType<Wire<ResponseValue<'flow.libraryList'>>> = z.object({ blocks: z.array(blockWireSchema) })

/** flow.librarySave request payload. */
export const flowLibrarySaveRequestSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  kind: z.string(),
  description: z.string(),
  code: z.string().optional(),
  inputs: z.array(z.object({ name: z.string(), type: z.string(), description: z.string().optional() })),
  outputs: z.array(z.object({ name: z.string(), type: z.string(), description: z.string().optional() })),
  params: z.array(z.object({
    name: z.string(),
    type: z.string(),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    description: z.string().optional(),
  })),
  sourceFlowId: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'flow.librarySave'>>>

/** flow.librarySave response value. */
export const flowLibrarySaveValueSchema: z.ZodType<Wire<ResponseValue<'flow.librarySave'>>> = z.object({ block: blockWireSchema })

/** flow.libraryDelete request payload. */
export const flowLibraryDeleteRequestSchema = z.object({ id: z.string() }) satisfies z.ZodType<Wire<RequestPayload<'flow.libraryDelete'>>>

/** flow.libraryDelete response value. */
export const flowLibraryDeleteValueSchema = z.object({ deleted: z.literal(true) }) satisfies z.ZodType<Wire<ResponseValue<'flow.libraryDelete'>>>
