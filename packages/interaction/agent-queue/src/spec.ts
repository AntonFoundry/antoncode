import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const sessionId = z.string().min(1).transform(SessionId)
const workspaceId = z.string().min(1).transform(WorkspaceId)

/** A message belongs to one workspace; recipients freeze direct and topic fan-out at publication. */
export const queueMessage = z.object({
  id: z.uuid(),
  workspaceId,
  seq: z.number().int().positive(),
  sender: sessionId,
  recipients: z.array(sessionId),
  /** Topic marker: workspace-wide means fan-out to subscriptions active at publish, not future subscribers. */
  workspaceWide: z.boolean(),
  body: z.string().min(1).max(65536),
  createdAt: z.number().int().nonnegative(),
})
/** Durable workspace message with recipients frozen at publication. */
export type QueueMessage = z.infer<typeof queueMessage>

/** Session delivery cursor: direct mail creates it without opting into workspace broadcasts. */
export const queueSubscription = z.object({
  workspaceId,
  sessionId,
  cursor: z.number().int().nonnegative(),
  /** Only explicit subscription opts this address into later workspace topic publishes. */
  workspaceSubscribed: z.boolean().default(true),
})
/** Durable per-session acknowledgement cursor and workspace broadcast opt-in. */
export type QueueSubscription = z.infer<typeof queueSubscription>

/** Atomic workspace sequence allocation and retained addressed messages. */
export const queueWorkspace = z.object({
  nextSeq: z.number().int().positive(),
  messages: z.array(queueMessage),
})
/** Stored workspace stream head and retained messages. */
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
