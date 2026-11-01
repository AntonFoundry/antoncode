/* Durable workspace-scoped communication, independent of agent turn scheduling. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { authorizeWorkspaceMember, resolveAuthorizedWorkspace } from './membership.ts'
import type { MembershipFailure } from './membership.ts'
import { agentQueueDomainSpec, queueMessage } from './spec.ts'
import type { QueueMessage, QueueSubscription, QueueWorkspace } from './spec.ts'

export { agentQueueDomainSpec, queueMessage, queueSubscription } from './spec.ts'
export type { QueueMessage, QueueSubscription } from './spec.ts'
export { authorizeWorkspaceMember, resolveAuthorizedWorkspace, forgedCallerError } from './membership.ts'
export type { MembershipFailure } from './membership.ts'

/** Maximum retained messages per workspace; a full unread backlog rejects new publishes. */
export const MAX_WORKSPACE_MESSAGES = 1024
/** Maximum explicitly addressed sessions per publish (topic subscribers are bounded separately). */
export const MAX_DIRECT_RECIPIENTS = 32
/** Maximum encoded message body length in UTF-16 code units. */
export const MAX_BODY_LENGTH = 65536

declare module '@deepseek-ai/cordis' {
  interface Context { agentQueue: AgentQueue }
}

export interface PublishRequest {
  /** Optional workspace guard; when supplied it must equal the caller's workspace. */
  readonly workspaceId?: WorkspaceId
  /** Workspace topic: include only the subscriptions present at durable publication. */
  readonly workspaceWide?: boolean
  /** Durable session addresses within the sender's workspace. */
  readonly recipients?: readonly SessionId[]
  readonly body: string
}

export interface ReadPage {
  readonly messages: readonly QueueMessage[]
  readonly cursor: number
  readonly hasMore: boolean
}

export interface QueueNotice {
  readonly workspaceId: WorkspaceId
  readonly seq: number
}

/** A subscriber callback is advisory; replay with read() after registering to close races. */
export type QueueListener = (notice: QueueNotice) => void

const key = (workspaceId: WorkspaceId, sessionId: SessionId): string =>
  JSON.stringify([workspaceId, sessionId])
const bounded = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('queue read limit must be an integer between 1 and 100')
  }
  return limit
}

/** Host-owned durable queue; publishing never sends agent inbox input or wakes a model. */
export class AgentQueue extends Service {
  static inject = ['storageDomain', 'workspaceRegistry', 'agents']
  private workspaces?: KvTable<string, QueueWorkspace>
  private subscriptions?: KvTable<string, QueueSubscription>
  private readonly listeners = new Map<string, Set<QueueListener>>()
  private readonly activeSubscriptions = new Set<string>()
  private operationTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context) { super(ctx, 'agentQueue') }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentQueueDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'agentQueue.domainClose')
    this.workspaces = domain.table('workspaces')
    this.subscriptions = domain.table('subscriptions')
  }

  private records(): KvTable<string, QueueWorkspace> {
    if (!this.workspaces) throw new Error('agent queue is not initialized')
    return this.workspaces
  }

  private accounts(): KvTable<string, QueueSubscription> {
    if (!this.subscriptions) throw new Error('agent queue is not initialized')
    return this.subscriptions
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(task)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Validate exact live Agent identity and canonical membership or a subagent lineage. */
  private authorize(agent: Agent): Promise<Workspace> {
    return authorizeWorkspaceMember(this.ctx, agent)
  }

  private authorizedWorkspace(agent: Agent, failure?: MembershipFailure): Promise<Workspace | undefined> {
    return resolveAuthorizedWorkspace(this.ctx, agent, failure)
  }

  private async eligibleRecipient(id: SessionId, workspace: Workspace): Promise<boolean> {
    const recipient = this.ctx.agents.get(id)
    if (!recipient) return workspace.sessionIds.includes(id)
    const authorized = await this.authorizedWorkspace(recipient)
    return !!authorized && authorized.id === workspace.id && authorized.path === workspace.path
  }

  /** Discover the caller's durable session address and workspace peers. */
  async identities(agent: Agent): Promise<{ workspaceId: WorkspaceId; sessionId: SessionId; sessionIds: readonly SessionId[] }> {
    const workspace = await this.authorize(agent)
    const children = this.ctx.agents.list()
      .filter(candidate => candidate.session.header.parentSession !== undefined)
    const eligible: SessionId[] = []
    for (const child of children) {
      try {
        if (await this.eligibleRecipient(child.id, workspace)) eligible.push(child.id)
      } catch {
        // An unrelated invalid live lineage must not prevent this caller from discovering peers.
      }
    }
    return { workspaceId: workspace.id, sessionId: agent.id, sessionIds: [...new Set([...workspace.sessionIds, ...eligible])] }
  }

  private requireWorkspace(workspace: Workspace, requested?: WorkspaceId): void {
    if (requested !== undefined && requested !== workspace.id) {
      throw new Error('queue workspace does not match the caller workspace')
    }
  }

  /** Opt into future workspace broadcasts; direct messages need no topic subscription. */
  async subscribe(agent: Agent, workspaceId?: WorkspaceId, listener?: QueueListener, signal?: AbortSignal): Promise<() => void> {
    const workspace = await this.authorize(agent)
    this.requireWorkspace(workspace, workspaceId)
    if (signal?.aborted) throw signal.reason ?? new Error('subscription aborted')
    const id = key(workspace.id, agent.id)
    await this.enqueue(async () => {
      const currentWorkspace = await this.authorizedWorkspace(agent)
      if (!currentWorkspace || currentWorkspace.id !== workspace.id || currentWorkspace.path !== workspace.path) {
        throw new Error('queue membership changed before subscription')
      }
      const account = this.accounts().get(id)
      if (!account || !account.workspaceSubscribed) {
        await this.accounts().put(id, {
          workspaceId: workspace.id, sessionId: agent.id,
          cursor: account?.cursor ?? 0, workspaceSubscribed: true,
        })
      }
    })
    if (signal?.aborted) throw signal.reason ?? new Error('subscription aborted')
    if (!listener) return () => undefined
    let listeners = this.listeners.get(id)
    if (!listeners) { listeners = new Set(); this.listeners.set(id, listeners) }
    listeners.add(listener)
    this.activeSubscriptions.add(id)
    const dispose = () => {
      const current = this.listeners.get(id)
      current?.delete(listener)
      if (!current?.size) { this.listeners.delete(id); this.activeSubscriptions.delete(id) }
      signal?.removeEventListener('abort', dispose)
    }
    signal?.addEventListener('abort', dispose, { once: true })
    // Replay only addressed unread mail after listener installation; read() remains authoritative.
    const cursor = this.accounts().get(id)?.cursor ?? 0
    const latest = this.records().get(workspace.id)?.messages.findLast(message =>
      message.seq > cursor && this.addressed(message, agent.id))
    if (latest) this.notify(listener, { workspaceId: workspace.id, seq: latest.seq })
    return dispose
  }

  /** Remove a session's durable workspace subscription and reset its cursor. */
  async unsubscribe(agent: Agent, workspaceId?: WorkspaceId): Promise<boolean> {
    const workspace = await this.authorize(agent)
    this.requireWorkspace(workspace, workspaceId)
    const id = key(workspace.id, agent.id)
    return this.enqueue(async () => {
      const currentWorkspace = await this.authorizedWorkspace(agent)
      if (!currentWorkspace || currentWorkspace.id !== workspace.id || currentWorkspace.path !== workspace.path) {
        throw new Error('queue membership changed before unsubscription')
      }
      const account = this.accounts().get(id)
      if (!account?.workspaceSubscribed) return false
      // An unsubscription with unread deliveries would strand them indefinitely.
      if (this.records().get(workspace.id)?.messages.some(message =>
        message.seq > account.cursor && this.addressed(message, agent.id))) {
        throw new Error('acknowledge unread queue messages before unsubscribing')
      }
      await this.accounts().put(id, { ...account, workspaceSubscribed: false })
      this.listeners.get(id)?.clear()
      this.listeners.delete(id)
      this.activeSubscriptions.delete(id)
      return true
    })
  }

  /** Publish one durable fan-out message; direct targets must already belong to the workspace. */
  async publish(agent: Agent, request: PublishRequest): Promise<QueueMessage> {
    const workspace = await this.authorize(agent)
    this.requireWorkspace(workspace, request.workspaceId)
    if (typeof request.workspaceWide !== 'undefined' && typeof request.workspaceWide !== 'boolean') {
      throw new TypeError('invalid queue workspaceWide')
    }
    const recipients = [...new Set(request.recipients ?? [])]
    if (recipients.length > MAX_DIRECT_RECIPIENTS) throw new RangeError('queue has too many direct recipients')
    if (recipients.some(id => typeof id !== 'string' || id.length === 0)) throw new TypeError('invalid queue recipient')
    if (!request.workspaceWide && recipients.length === 0) throw new Error('queue message needs a recipient or workspaceWide')
    const body = queueMessage.shape.body.parse(request.body)
    return this.enqueue(async () => {
      // Recheck sender lineage and each target at the serialized write boundary.
      if (this.ctx.agents.get(agent.id) !== agent) throw new Error('queue caller must be the exact live agent')
      const currentWorkspace = await this.authorizedWorkspace(agent)
      if (!currentWorkspace || currentWorkspace.id !== workspace.id || currentWorkspace.path !== workspace.path) {
        throw new Error('queue membership changed before publication')
      }
      for (const recipient of recipients) {
        if (!await this.eligibleRecipient(recipient, workspace)) {
          throw new Error('queue recipient does not belong to the sender workspace')
        }
      }
      // The workspace topic resolves to eligible durable subscriptions now; later subscribers never see this message.
      const frozen: SessionId[] = []
      if (request.workspaceWide) {
        for (const [, subscription] of this.accounts().entries()) {
          if (subscription.workspaceId === workspace.id && subscription.workspaceSubscribed
            && await this.eligibleRecipient(subscription.sessionId, workspace)) frozen.push(subscription.sessionId)
        }
      }
      const addresses = [...new Set([...recipients, ...frozen])]
      if (addresses.length === 0) {
        throw new Error('workspace topic has no current subscribers; no recipients to deliver to')
      }
      const current = this.records().get(workspace.id) ?? { nextSeq: 1, messages: [] }
      // Collect only messages acknowledged by every subscribed addressee. Unsubscribed direct targets
      // cannot acknowledge, so their messages stay retained until an explicit future subscription/ack.
      const retained = current.messages.filter(message =>
        message.recipients.some((target) => {
          const subscription = this.accounts().get(key(workspace.id, target))
          return !subscription || subscription.cursor < message.seq
        }))
      if (retained.length >= MAX_WORKSPACE_MESSAGES) {
        throw new RangeError('workspace queue backlog is full; acknowledge messages before publishing')
      }
      if (!Number.isSafeInteger(current.nextSeq + 1)) throw new RangeError('workspace queue sequence exhausted')
      const message: QueueMessage = {
        id: randomUUID(), workspaceId: workspace.id, seq: current.nextSeq,
        sender: agent.id, recipients: addresses, workspaceWide: !!request.workspaceWide,
        body, createdAt: Date.now(),
      }
      // Direct delivery first creates an independent cursor without opting the address into topics.
      // If persistence fails, roll back provisional cursors; this method remains the only serialized writer.
      const provisional: SessionId[] = []
      try {
        for (const recipient of recipients) {
          const address = key(workspace.id, recipient)
          if (this.accounts().get(address)) continue
          await this.accounts().put(address, {
            workspaceId: workspace.id, sessionId: recipient, cursor: 0, workspaceSubscribed: false,
          })
          provisional.push(recipient)
        }
        // Sequence + compaction + message share one durable workspace-domain write.
        await this.records().put(workspace.id, {
          nextSeq: current.nextSeq + 1, messages: [...retained, message],
        })
      } catch (error) {
        const failures: unknown[] = []
        for (const recipient of provisional) {
          try { await this.accounts().delete(key(workspace.id, recipient)) } catch (rollbackError) { failures.push(rollbackError) }
        }
        if (failures.length) throw new AggregateError([error, ...failures], 'queue publish rollback failed')
        throw error
      }
      // Notifications follow durable commit. Listener failure cannot undo or reject the write.
      for (const [id, listeners] of this.listeners) {
        if (!this.activeSubscriptions.has(id)) continue
        const subscription = this.accounts().get(id)
        if (subscription?.workspaceId !== workspace.id) continue
        if (!this.addressed(message, subscription.sessionId)) continue
        for (const listener of listeners) this.notify(listener, { workspaceId: workspace.id, seq: message.seq })
      }
      return message
    })
  }

  private addressed(message: QueueMessage, sessionId: SessionId): boolean {
    return message.recipients.includes(sessionId)
  }

  private notify(listener: QueueListener, notice: QueueNotice): void {
    try { listener(notice) } catch { /* delivery is advisory; durable replay remains available */ }
  }

  /** Read after the ack cursor by default. Explicit cursor/after may replay below ack only while retained. */
  async read(
    agent: Agent,
    options: { workspaceId?: WorkspaceId; cursor?: number; after?: number; limit?: number } = {},
  ): Promise<ReadPage> {
    const workspace = await this.authorize(agent)
    this.requireWorkspace(workspace, options.workspaceId)
    if (options.cursor !== undefined && options.after !== undefined && options.cursor !== options.after) {
      throw new Error('queue cursor and after disagree')
    }
    const subscription = this.accounts().get(key(workspace.id, agent.id))
    const currentWorkspace = await this.authorizedWorkspace(agent)
    if (!currentWorkspace || currentWorkspace.id !== workspace.id) throw new Error('queue membership changed before reading')
    if (!subscription) throw new Error('queue session has no addressed messages; subscribe to receive workspace broadcasts')
    const after = options.cursor ?? options.after ?? subscription.cursor
    if (!Number.isSafeInteger(after) || after < 0) throw new RangeError('queue cursor must be a nonnegative safe integer')
    const limit = bounded(options.limit ?? 50)
    const visible = (this.records().get(workspace.id)?.messages ?? [])
      .filter(message => message.seq > after && this.addressed(message, agent.id))
    return { messages: visible.slice(0, limit), cursor: subscription.cursor, hasMore: visible.length > limit }
  }

  /** Advance only this session's acknowledged cursor, never beyond committed stream head. */
  async ack(agent: Agent, workspaceId: WorkspaceId, throughSeq: number): Promise<number> {
    const workspace = await this.authorize(agent)
    this.requireWorkspace(workspace, workspaceId)
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) throw new RangeError('queue cursor must be nonnegative')
    const id = key(workspace.id, agent.id)
    return this.enqueue(async () => {
      const currentWorkspace = await this.authorizedWorkspace(agent)
      if (!currentWorkspace || currentWorkspace.id !== workspace.id || currentWorkspace.path !== workspace.path) {
        throw new Error('queue membership changed before acknowledgment')
      }
      const subscription = this.accounts().get(id)
      if (!subscription) throw new Error('queue session must subscribe before acknowledging')
      const head = (this.records().get(workspace.id)?.nextSeq ?? 1) - 1
      if (throughSeq > head) throw new RangeError('cannot acknowledge beyond committed queue head')
      if (throughSeq <= subscription.cursor) return subscription.cursor
      await this.accounts().put(id, { ...subscription, cursor: throughSeq })
      return throughSeq
    })
  }
}

export default AgentQueue
