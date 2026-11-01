/**
 * Durable form of the cross-workspace direct mailbox. One global singleton
 * record owns the canonical message log, the recipient index, and every
 * delivery cursor, so a single `global.set` commits a complete fan-out
 * atomically. The v1 `agent_queue` domain is a separate medium and is never
 * read or written by this domain.
 * @module @deepseek-ai/dsh-agent-queue/src/direct-spec
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const sessionId = z.string().min(1).transform(SessionId)
const workspaceId = z.string().min(1).transform(WorkspaceId)

/** One addressee of a direct message with the workspace it occupied at send time. */
export const directAddress = z.object({
  sessionId,
  workspaceId,
})
/** Addressee projection: a durable session id with its workspace at send time. */
export type DirectAddress = z.infer<typeof directAddress>

/**
 * A canonical direct message. `seq` is global to the mailbox, not per
 * workspace: addressees in different workspaces share one ordering.
 */
export const directMessage = z.object({
  id: z.uuid(),
  seq: z.number().int().positive(),
  sender: sessionId,
  senderWorkspaceId: workspaceId,
  /** Frozen addressees; direct messaging has no topic and no later fan-out. */
  recipients: z.array(directAddress).min(1),
  body: z.string().min(1).max(65536),
  createdAt: z.number().int().nonnegative(),
})
/** One canonical direct message in the cross-workspace mailbox. */
export type DirectMessage = z.infer<typeof directMessage>

/** Recipient index entry: one durable inbox cursor per addressed session. */
export const directInbox = z.object({
  sessionId,
  /** Workspace observed when the inbox was created or last addressed; advisory. */
  workspaceId,
  cursor: z.number().int().nonnegative(),
})
/** One recipient-index entry: a session's durable direct-mail cursor. */
export type DirectInbox = z.infer<typeof directInbox>

/** The single global record: sequence, canonical messages, and recipient index. */
export const directQueueState = z.object({
  nextSeq: z.number().int().positive(),
  messages: z.array(directMessage),
  inboxes: z.array(directInbox),
})
/** Complete durable state of the direct mailbox, held in one global record. */
export type DirectQueueState = z.infer<typeof directQueueState>

/** Value served before the first write, and after reopening a medium that never held direct mail. */
export const emptyDirectQueueState: DirectQueueState = { nextSeq: 1, messages: [], inboxes: [] }

/**
 * Direct-mailbox domain. Declaring no table keeps every fan-out in one
 * durable write: message, recipient index, and cursors cannot diverge, so the
 * service needs no cross-table rollback.
 */
export const agentDirectQueueDomainSpec = defineDomain({
  name: 'agent_queue_direct',
  version: 1,
  global: { schema: directQueueState, initial: emptyDirectQueueState },
  tables: {},
})
