import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema, workspaceIdSchema } from './sessions.schema.ts'

const session = z.object({ sessionId: sessionIdSchema })
const access = session.extend({ grant: z.string().uuid() })
const cursor = z.number().int().nonnegative().safe()
const operation = z.enum([
  'address', 'local-read', 'local-send', 'local-ack', 'direct-read', 'direct-send', 'direct-ack',
])
const channel = z.enum(['local', 'direct'])
const message = z.object({
  seq: cursor, sender: sessionIdSchema, senderWorkspaceId: workspaceIdSchema,
  body: z.string(), createdAt: z.number(),
})
export const agentMailBeginRequestSchema = session.extend({ operations: z.array(operation).min(1).max(7) }) satisfies z.ZodType<Wire<RequestPayload<'agentMail.begin'>>>
export const agentMailBeginValueSchema = z.object({ requestId: z.string(), expiresAt: z.number() }) satisfies z.ZodType<Wire<ResponseValue<'agentMail.begin'>>>
export const agentMailAuthorizeRequestSchema = session.extend({ operations: z.array(operation).min(1).max(7) }) satisfies z.ZodType<Wire<RequestPayload<'agentMail.authorize'>>>
export const agentMailAuthorizeValueSchema = z.object({ grant: z.string().uuid() }) satisfies z.ZodType<Wire<ResponseValue<'agentMail.authorize'>>>
export const agentMailRedeemRequestSchema = session.extend({ requestId: z.string().uuid(), code: z.string().max(8) }) satisfies z.ZodType<Wire<RequestPayload<'agentMail.redeem'>>>
export const agentMailRedeemValueSchema = z.object({ grant: z.string().uuid() }) satisfies z.ZodType<Wire<ResponseValue<'agentMail.redeem'>>>
export const agentMailRevokeRequestSchema = access satisfies z.ZodType<Wire<RequestPayload<'agentMail.revoke'>>>
export const agentMailRevokeValueSchema = z.object({ revoked: z.literal(true) }) satisfies z.ZodType<Wire<ResponseValue<'agentMail.revoke'>>>
export const agentMailAddressRequestSchema = access.extend({
  peerCursor: z.string().max(512).optional(), peerLimit: z.number().int().min(1).max(128).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'agentMail.address'>>>
export const agentMailAddressValueSchema = z.object({
  sessionId: sessionIdSchema, workspaceId: workspaceIdSchema,
  inboxCursor: cursor, unread: cursor,
  peers: z.array(z.object({
    sessionId: sessionIdSchema, workspaceId: workspaceIdSchema,
    transport: z.enum(['direct', 'workspace-queue']),
  })), hasMorePeers: z.boolean(), nextPeerCursor: z.string().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'agentMail.address'>>>
export const agentMailInboxRequestSchema = access.extend({
  channel, cursor: cursor.optional(), limit: z.number().int().min(1).max(100).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'agentMail.inbox'>>>
export const agentMailInboxValueSchema = z.object({
  messages: z.array(message), cursor, hasMore: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'agentMail.inbox'>>>
export const agentMailSendRequestSchema = access.extend({
  channel, recipients: z.array(sessionIdSchema).max(32),
  workspaceWide: z.boolean().optional(), body: z.string().min(1).max(65536),
}) satisfies z.ZodType<Wire<RequestPayload<'agentMail.send'>>>
export const agentMailSendValueSchema = z.object({ seq: cursor }) satisfies z.ZodType<Wire<ResponseValue<'agentMail.send'>>>
export const agentMailAckRequestSchema = access.extend({ channel, throughSeq: cursor }) satisfies z.ZodType<Wire<RequestPayload<'agentMail.ack'>>>
export const agentMailAckValueSchema = z.object({ cursor }) satisfies z.ZodType<Wire<ResponseValue<'agentMail.ack'>>>
