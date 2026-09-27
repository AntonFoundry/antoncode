/**
 * orchestrator domain zod schemas. The board response reuses the workspace and
 * session summary projections verbatim, so the Orchestrator board reads exactly
 * the rows `workspace.list` and `session.list` serve — one wire shape, one
 * projection owner.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema, sessionSummarySchema } from './sessions.schema.ts'
import { workspaceViewSchema } from './workspace.schema.ts'

/** orchestrator.board request payload (empty object literal). */
export const orchestratorBoardRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'orchestrator.board'>>>

/** orchestrator.board response value: the board's complete input snapshot. */
// Annotation, not `satisfies`: the projections reuse branded session/workspace
// ids whose brand symbol is not nameable from this module (same accommodation
// as sessionListValueSchema).
export const orchestratorBoardValueSchema: z.ZodType<Wire<ResponseValue<'orchestrator.board'>>> = z.object({
  items: z.array(workspaceViewSchema),
  archivedSessionIds: z.array(sessionIdSchema),
  sessions: z.array(sessionSummarySchema),
})

/** orchestrator.act request payload: the session to act on, and the action. */
export const orchestratorActRequestSchema = z.object({
  sessionId: sessionIdSchema,
  action: z.literal('kill'),
}) satisfies z.ZodType<Wire<RequestPayload<'orchestrator.act'>>>

/** orchestrator.act response value. */
export const orchestratorActValueSchema = z.object({
  accepted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'orchestrator.act'>>>
