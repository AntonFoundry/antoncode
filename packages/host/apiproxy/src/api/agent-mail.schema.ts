/** Wire validation for Agent mail pairing, scoped grants, queue access, and acknowledgements. */
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
/** Native pairing request with one to seven named operations; operation uniqueness is checked by the ledger. */
export const agentMailBeginRequestSchema = session.extend({ operations: z.array(operation).min(1).max(7) }) satisfies z.ZodType<Wire<RequestPayload<'agentMail.begin'>>>
/** Browser-visible challenge identity and expiry, excluding the native code and binding. */
export const agentMailBeginValueSchema = z.object({ requestId: z.string(), expiresAt: z.number() }) satisfies z.ZodType<Wire<ResponseValue<'agentMail.begin'>>>
/** Local UI authorization request with one to seven named operations. */
export const agentMailAuthorizeRequestSchema = session.extend({ operations: z.array(operation).min(1).max(7) }) satisfies z.ZodType<Wire<RequestPayload<'agentMail.authorize'>>>
/** Bearer grant returned after local UI authorization. */
export const agentMailAuthorizeValueSchema = z.object({ grant: z.string().uuid() }) satisfies z.ZodType<Wire<ResponseValue<'agentMail.authorize'>>>
/** Native challenge redemption request; code format and attempts are enforced by the verifier. */
export const agentMailRedeemRequestSchema = session.extend({ requestId: z.string().uuid(), code: z.string().max(8) }) satisfies z.ZodType<Wire<RequestPayload<'agentMail.redeem'>>>
/** Bearer grant returned after native challenge redemption. */
export const agentMailRedeemValueSchema = z.object({ grant: z.string().uuid() }) satisfies z.ZodType<Wire<ResponseValue<'agentMail.redeem'>>>
/** Session and bearer grant identifying the authorization to revoke. */
export const agentMailRevokeRequestSchema = access satisfies z.ZodType<Wire<RequestPayload<'agentMail.revoke'>>>
/** Successful grant-revocation receipt. */
export const agentMailRevokeValueSchema = z.object({ revoked: z.literal(true) }) satisfies z.ZodType<Wire<ResponseValue<'agentMail.revoke'>>>
/** Authorized address lookup with optional peer pagination bounded to 128 entries per page. */
export const agentMailAddressRequestSchema = access.extend({
  peerCursor: z.string().max(512).optional(), peerLimit: z.number().int().min(1).max(128).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'agentMail.address'>>>
/** Address, inbox counters, and paginated peer transport descriptions. */
export const agentMailAddressValueSchema = z.object({
  sessionId: sessionIdSchema, workspaceId: workspaceIdSchema,
  inboxCursor: cursor, unread: cursor,
  peers: z.array(z.object({
    sessionId: sessionIdSchema, workspaceId: workspaceIdSchema,
    transport: z.enum(['direct', 'workspace-queue']),
  })), hasMorePeers: z.boolean(), nextPeerCursor: z.string().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'agentMail.address'>>>
/** Authorized channel read with an optional cursor and page size from one to 100. */
export const agentMailInboxRequestSchema = access.extend({
  channel, cursor: cursor.optional(), limit: z.number().int().min(1).max(100).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'agentMail.inbox'>>>
/** Inbox page with its continuation cursor and remaining-message indicator. */
export const agentMailInboxValueSchema = z.object({
  messages: z.array(message), cursor, hasMore: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'agentMail.inbox'>>>
/** Authorized send request allowing up to 32 recipients and an optional workspace-wide destination. */
export const agentMailSendRequestSchema = access.extend({
  channel, recipients: z.array(sessionIdSchema).max(32),
  workspaceWide: z.boolean().optional(), body: z.string().min(1).max(65536),
}) satisfies z.ZodType<Wire<RequestPayload<'agentMail.send'>>>
/** Queue sequence assigned to a sent message. */
export const agentMailSendValueSchema = z.object({ seq: cursor }) satisfies z.ZodType<Wire<ResponseValue<'agentMail.send'>>>
/** Authorized channel acknowledgement through a nonnegative safe-integer sequence. */
export const agentMailAckRequestSchema = access.extend({ channel, throughSeq: cursor }) satisfies z.ZodType<Wire<RequestPayload<'agentMail.ack'>>>
/** Acknowledgement cursor returned by the queue. */
export const agentMailAckValueSchema = z.object({ cursor }) satisfies z.ZodType<Wire<ResponseValue<'agentMail.ack'>>>
