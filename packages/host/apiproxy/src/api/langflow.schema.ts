/**
 * langflow domain zod schemas. The wire status mirrors the sidecar's exact
 * `LangflowStatus` snapshot with optional fields widened per the Wire<>
 * accommodation documented on the dispatch table.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** One sidecar status snapshot on the wire. */
export const langflowStatusWireSchema = z.object({
  state: z.enum(['stopped', 'starting', 'running', 'error']),
  url: z.string().optional(),
  pid: z.number().optional(),
  error: z.string().optional(),
})

/** langflow.status request payload (empty object literal). */
export const langflowStatusRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'langflow.status'>>>

/** langflow.status response value. */
export const langflowStatusValueSchema: z.ZodType<Wire<ResponseValue<'langflow.status'>>> = z.object({
  status: langflowStatusWireSchema,
})

/** langflow.start request payload (empty object literal). */
export const langflowStartRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'langflow.start'>>>

/** langflow.start response value. */
export const langflowStartValueSchema: z.ZodType<Wire<ResponseValue<'langflow.start'>>> = z.object({
  status: langflowStatusWireSchema,
})

/** langflow.stop request payload (empty object literal). */
export const langflowStopRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'langflow.stop'>>>

/** langflow.stop response value. */
export const langflowStopValueSchema: z.ZodType<Wire<ResponseValue<'langflow.stop'>>> = z.object({
  status: langflowStatusWireSchema,
})
