/** term domain zod schemas. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** term.spawn request payload; sizes default to the host's 80x24. */
export const termSpawnRequestSchema = z.object({
  cols: z.number().optional(),
  rows: z.number().optional(),
  cwd: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'term.spawn'>>>

/** term.spawn response value. */
export const termSpawnValueSchema = z.object({
  sessionId: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'term.spawn'>>>

/** term.read request payload; `since` is the client's consumed cursor. */
export const termReadRequestSchema = z.object({
  sessionId: z.string(),
  since: z.number(),
}) satisfies z.ZodType<Wire<RequestPayload<'term.read'>>>

/** term.read response value. */
export const termReadValueSchema = z.object({
  data: z.string(),
  next: z.number(),
  exited: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'term.read'>>>

/** term.input request payload; `data` is raw UTF-8 keystrokes/paste. */
export const termInputRequestSchema = z.object({
  sessionId: z.string(),
  data: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'term.input'>>>

/** term.input response value. */
export const termInputValueSchema = z.object({
  wrote: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'term.input'>>>

/** term.resize request payload. */
export const termResizeRequestSchema = z.object({
  sessionId: z.string(),
  cols: z.number(),
  rows: z.number(),
}) satisfies z.ZodType<Wire<RequestPayload<'term.resize'>>>

/** term.resize response value. */
export const termResizeValueSchema = z.object({
  resized: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'term.resize'>>>

/** term.dispose request payload. */
export const termDisposeRequestSchema = z.object({
  sessionId: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'term.dispose'>>>

/** term.dispose response value. */
export const termDisposeValueSchema = z.object({
  disposed: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'term.dispose'>>>
