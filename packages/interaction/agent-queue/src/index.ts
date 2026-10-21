/* Durable workspace-scoped communication, independent of agent turn scheduling. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { agentQueueDomainSpec, queueMessage } from './spec.ts'
import type { QueueMessage, QueueSubscription, QueueWorkspace } from './spec.ts'

export { agentQueueDomainSpec, queueMessage, queueSubscription } from './spec.ts'
export type { QueueMessage, QueueSubscription } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { agentQueue: AgentQueue }
}

export interface PublishRequest {
  /** Deliver to every explicitly subscribed session in the workspace. */
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

  /** Validate exact live Agent identity and immutable canonical workspace membership. */
  private async authorize(agent: Agent): Promise<Workspace> {
    if (this.ctx.agents.get(agent.id) !== agent || agent.session.header.id !== agent.id) {
      throw new Error('queue caller must be the exact live agent')
    }
    const cwd = agent.session.header.cwd
    if (!cwd) throw new Error('queue caller has no workspace directory')
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd)
    if (this.ctx.agents.get(agent.id) !== agent || !workspace || !workspace.sessionIds.includes(agent.id)) {
      throw new Error('queue caller is not a member of a registered workspace')
    }
    return workspace
  }

  /** Explicit durable subscription. By default, existing stream history is available. */
  async subscribe(agent: Agent, listener?: QueueListener, signal?: AbortSignal): Promise<() => void> {
    const workspace = await this.authorize(agent)
    if (signal?.aborted) throw signal.reason ?? new Error('subscription aborted')
    const id = key(workspace.id, agent.id)
    await this.enqueue(async () => {
      if (this.ctx.agents.get(agent.id) !== agent || !workspace.sessionIds.includes(agent.id)) {
        throw new Error('queue membership changed before subscription')
      }
      if (!this.accounts().get(id)) {
        await this.accounts().put(id, { workspaceId: workspace.id, sessionId: agent.id, cursor: 0 })
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
    // Replay notice after listener installation; read() is authoritative and deduplicates by seq.
    const latest = this.records().get(workspace.id)?.nextSeq ?? 1
    if (latest > 1) this.notify(listener, { workspaceId: workspace.id, seq: latest - 1 })
    return dispose
  }

  /** Remove a session's durable workspace subscription and reset its cursor. */
  async unsubscribe(agent: Agent): Promise<boolean> {
    const workspace = await this.authorize(agent)
    const id = key(workspace.id, agent.id)
    return this.enqueue(async () => {
      if (this.ctx.agents.get(agent.id) !== agent || !workspace.sessionIds.includes(agent.id)) {
        throw new Error('queue membership changed before unsubscription')
      }
      this.listeners.get(id)?.clear()
      this.listeners.delete(id)
      this.activeSubscriptions.delete(id)
      return this.accounts().delete(id)
    })
  }

  /** Publish one durable fan-out message; direct targets must already belong to the workspace. */
  async publish(agent: Agent, request: PublishRequest): Promise<QueueMessage> {
    const workspace = await this.authorize(agent)
    if (!request || !Array.isArray(request.recipients ?? []) || typeof request.workspaceWide !== 'undefined' && typeof request.workspaceWide !== 'boolean') {
      throw new TypeError('invalid queue recipients or workspaceWide')
    }
    const recipients = [...new Set(request.recipients ?? [])]
    if (recipients.some(id => typeof id !== 'string' || id.length === 0)) throw new TypeError('invalid queue recipient')
    if (!request.workspaceWide && recipients.length === 0) throw new Error('queue message needs a recipient or workspaceWide')
    if (recipients.some(id => !workspace.sessionIds.includes(id))) {
      throw new Error('queue recipient does not belong to the sender workspace')
    }
    const body = queueMessage.shape.body.parse(request.body)
    return this.enqueue(async () => {
      // Recheck durable membership at the serialized write boundary.
      if (this.ctx.agents.get(agent.id) !== agent || !workspace.sessionIds.includes(agent.id)
        || recipients.some(id => !workspace.sessionIds.includes(id))) {
        throw new Error('queue membership changed before publication')
      }
      const current = this.records().get(workspace.id) ?? { nextSeq: 1, messages: [] }
      if (!Number.isSafeInteger(current.nextSeq + 1)) throw new RangeError('workspace queue sequence exhausted')
      const message: QueueMessage = {
        id: randomUUID(), workspaceId: workspace.id, seq: current.nextSeq,
        sender: agent.id, recipients, workspaceWide: !!request.workspaceWide,
        body, createdAt: Date.now(),
      }
      await this.records().put(workspace.id, {
        nextSeq: current.nextSeq + 1, messages: [...current.messages, message],
      })
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
    return message.workspaceWide || message.recipients.includes(sessionId)
  }

  private notify(listener: QueueListener, notice: QueueNotice): void {
    try { listener(notice) } catch { /* delivery is advisory; durable replay remains available */ }
  }

  /** Read from this subscription's cursor (or a later explicit replay cursor). */
  async read(agent: Agent, options: { after?: number; limit?: number } = {}): Promise<ReadPage> {
    const workspace = await this.authorize(agent)
    const subscription = this.accounts().get(key(workspace.id, agent.id))
    if (this.ctx.agents.get(agent.id) !== agent || !workspace.sessionIds.includes(agent.id)) {
      throw new Error('queue membership changed before reading')
    }
    if (!subscription) throw new Error('queue session must subscribe before reading')
    const after = options.after ?? subscription.cursor
    if (!Number.isSafeInteger(after) || after < 0) throw new RangeError('queue cursor must be a nonnegative safe integer')
    const limit = bounded(options.limit ?? 50)
    const visible = (this.records().get(workspace.id)?.messages ?? [])
      .filter(message => message.seq > after && this.addressed(message, agent.id))
    return { messages: visible.slice(0, limit), cursor: subscription.cursor, hasMore: visible.length > limit }
  }

  /** Advance only this session's acknowledged cursor, never beyond committed stream head. */
  async ack(agent: Agent, throughSeq: number): Promise<number> {
    const workspace = await this.authorize(agent)
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) throw new RangeError('queue cursor must be nonnegative')
    const id = key(workspace.id, agent.id)
    return this.enqueue(async () => {
      if (this.ctx.agents.get(agent.id) !== agent || !workspace.sessionIds.includes(agent.id)) {
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
