import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const sessionId = z.string().min(1).transform(SessionId)
const workspaceId = z.string().min(1).transform(WorkspaceId)

/** A message belongs to one workspace, with optional workspace-wide fan-out. */
export const queueMessage = z.object({
  id: z.string().uuid(),
  workspaceId,
  seq: z.number().int().positive().safe(),
  sender: sessionId,
  recipients: z.array(sessionId),
  workspaceWide: z.boolean(),
  body: z.string().min(1).max(65536),
  createdAt: z.number().int().nonnegative().safe(),
})
export type QueueMessage = z.infer<typeof queueMessage>

/** Subscription is durable and stores its own last acknowledged stream position. */
export const queueSubscription = z.object({
  workspaceId,
  sessionId,
  cursor: z.number().int().nonnegative().safe(),
})
export type QueueSubscription = z.infer<typeof queueSubscription>

export const queueWorkspace = z.object({
  nextSeq: z.number().int().positive().safe(),
  messages: z.array(queueMessage),
})
export type QueueWorkspace = z.infer<typeof queueWorkspace>

/** Each workspace record atomically owns its per-workspace sequence and messages. */
export const agentQueueDomainSpec = defineDomain({
  name: 'agent_queue',
  version: 1,
  tables: {
    workspaces: domainTable<string, QueueWorkspace>(queueWorkspace),
    subscriptions: domainTable<string, QueueSubscription>(queueSubscription),
  },
})
