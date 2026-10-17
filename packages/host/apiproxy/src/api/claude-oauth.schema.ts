/**
 * Claude-login zod schemas (names derived from map keys:
 * claudeOAuthStartRequestSchema / claudeOAuthStartValueSchema / …).
 * Snapshots never carry token material, so every field here is UI-safe.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { ClaudeLoginWire } from './claude-oauth.ts'

const loginWireSchema = z.object({
  loginId: z.string().min(1),
  status: z.enum(['pending', 'done', 'failed', 'cancelled']),
  verificationUri: z.string().url().optional(),
  error: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<ClaudeLoginWire>>

/** claudeOAuth.start request payload (empty) and login view value. */
export const claudeOAuthStartRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'claudeOAuth.start'>>>
export const claudeOAuthStartValueSchema = z.object({
  login: loginWireSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'claudeOAuth.start'>>>

/** claudeOAuth.submit request payload (login id plus pasted code). */
export const claudeOAuthSubmitRequestSchema = z.object({
  loginId: z.string().min(1),
  pasted: z.string().min(1).max(4096),
}) satisfies z.ZodType<Wire<RequestPayload<'claudeOAuth.submit'>>>
export const claudeOAuthSubmitValueSchema = z.object({
  login: loginWireSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'claudeOAuth.submit'>>>

/** claudeOAuth.cancel request payload (login id) and terminal view value. */
export const claudeOAuthCancelRequestSchema = z.object({
  loginId: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'claudeOAuth.cancel'>>>
export const claudeOAuthCancelValueSchema = z.object({
  login: loginWireSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'claudeOAuth.cancel'>>>
