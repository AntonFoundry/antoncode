/**
 * OpenCode-login zod schemas (names derived from map keys:
 * opencodeOAuthStartRequestSchema / opencodeOAuthStartValueSchema / …).
 * Snapshots never carry token material, so every field here is UI-safe.
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { OAuthLoginWire, OAuthOrgWire } from './opencode-oauth.ts'

const orgWireSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
}) satisfies z.ZodType<Wire<OAuthOrgWire>>

const loginWireSchema = z.object({
  loginId: z.string().min(1),
  status: z.enum(['pending', 'awaiting-org', 'done', 'denied', 'expired', 'cancelled']),
  userCode: z.string().min(1).optional(),
  verificationUri: z.string().url().optional(),
  intervalSeconds: z.number().positive().optional(),
  expiresInSeconds: z.number().positive().optional(),
  orgs: z.array(orgWireSchema).optional(),
  orgID: z.string().min(1).optional(),
  allowedModelCount: z.number().int().min(0).optional(),
  error: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<OAuthLoginWire>>

/** opencodeOAuth.start request payload (empty) and login view value. */
export const opencodeOAuthStartRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'opencodeOAuth.start'>>>
export const opencodeOAuthStartValueSchema = z.object({
  login: loginWireSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'opencodeOAuth.start'>>>

/** opencodeOAuth.status request payload (login id) and login view value. */
export const opencodeOAuthStatusRequestSchema = z.object({
  loginId: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'opencodeOAuth.status'>>>
export const opencodeOAuthStatusValueSchema = z.object({
  login: loginWireSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'opencodeOAuth.status'>>>

/** opencodeOAuth.select request payload (login id plus optional workspace). */
export const opencodeOAuthSelectRequestSchema = z.object({
  loginId: z.string().min(1),
  orgID: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'opencodeOAuth.select'>>>
export const opencodeOAuthSelectValueSchema = z.object({
  login: loginWireSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'opencodeOAuth.select'>>>

/** opencodeOAuth.cancel request payload (login id) and terminal view value. */
export const opencodeOAuthCancelRequestSchema = z.object({
  loginId: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'opencodeOAuth.cancel'>>>
export const opencodeOAuthCancelValueSchema = z.object({
  login: loginWireSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'opencodeOAuth.cancel'>>>
