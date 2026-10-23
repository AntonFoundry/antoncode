/**
 * Cross-workspace direct mailbox (`ctx.agentDirectQueue`). Addressing is
 * session-to-session ACROSS workspaces: a sender authorized in one registered
 * workspace addresses a session authorized in a different one. Mail inside a
 * single workspace — direct or topic — stays entirely on the v1 `agent_queue`
 * domain, so nothing here migrates or duplicates existing workspace messages. Delivery is durable and never wakes a model,
 * mutates an Agent inbox, or interrupts an inference.
 * @module @deepseek-ai/dsh-agent-queue/direct
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DomainGlobal } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { authorizeWorkspaceMember, resolveAuthorizedWorkspace } from './membership.ts'
import { agentDirectQueueDomainSpec, directMessage } from './direct-spec.ts'
import type { DirectAddress, DirectInbox, DirectMessage, DirectQueueState } from './direct-spec.ts'

export {
  agentDirectQueueDomainSpec, directAddress, directInbox, directMessage, directQueueState,
  emptyDirectQueueState,
} from './direct-spec.ts'
export type { DirectAddress, DirectInbox, DirectMessage, DirectQueueState } from './direct-spec.ts'

/** Maximum retained direct messages; a full unacknowledged mailbox rejects new sends. */
export const MAX_DIRECT_MESSAGES = 512
/** Maximum retained inbox cursors; a full recipient index rejects a send to a new address. */
export const MAX_DIRECT_INBOXES = 2048
/** Maximum addressees per direct send. */
export const MAX_DIRECT_RECIPIENTS = 32
/** Maximum body length in UTF-16 code units. */
export const MAX_DIRECT_BODY_LENGTH = 65536
/** Retention ceiling: a message older than this is dropped even if unacknowledged. */
export const DIRECT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/**
 * Hard ceiling on the encoded ledger record. The whole mailbox is one durable
 * value, so the message, index, and envelope bounds above are not sufficient on
 * their own: this bound is checked on the complete encoded record at the commit
 * point, where its final size is known.
 */
export const MAX_DIRECT_LEDGER_BYTES = 8 * 1024 * 1024

declare module '@deepseek-ai/cordis' {
  interface Context { agentDirectQueue: AgentDirectQueue }
}

/** One direct send: addressees are durable session ids in OTHER registered workspaces. */
export interface DirectSendRequest {
  readonly recipients: readonly SessionId[]
  readonly body: string
}

/**
 * Bounded direct-inbox page. `inboxCursor` is deliberately not named `cursor`:
 * it is the caller's position in the cross-workspace direct ledger and has
 * nothing to do with the per-workspace `cursor` of `agentQueue.read`.
 */
export interface DirectInboxPage {
  readonly messages: readonly DirectMessage[]
  readonly inboxCursor: number
  readonly hasMore: boolean
}

/** The caller's own cross-workspace address, direct-inbox position, and unread depth. */
export interface DirectIdentity {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  readonly inboxCursor: number
  readonly unread: number
}

const bounded = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('direct inbox limit must be an integer between 1 and 100')
  }
  return limit
}

/**
 * Delivery test, used for every read: a message reaches a caller only when the
 * caller's CURRENT authorized workspace still equals the workspace frozen in
 * its address. A session that moved to another workspace therefore cannot read
 * mail addressed to it in its former workspace, and a session that moves back
 * sees that mail again while it is retained.
 */
const readableBy = (message: DirectMessage, sessionId: SessionId, workspaceId: WorkspaceId): boolean =>
  message.recipients.some(recipient =>
    recipient.sessionId === sessionId && recipient.workspaceId === workspaceId)

/**
 * Reject any ledger that would violate the domain's own scope or bounds before
 * it reaches the medium: retained count, index size, ordering, and — the
 * invariant that keeps this ledger disjoint from the v1 workspace queue — the
 * absence of any addressee in the sender's own workspace.
 * @param next - Candidate ledger about to be committed.
 */
function verifyLedger(next: DirectQueueState): void {
  if (next.messages.length > MAX_DIRECT_MESSAGES) {
    throw new RangeError(`direct mailbox would retain ${next.messages.length} messages, above the ${MAX_DIRECT_MESSAGES}-message bound`)
  }
  if (next.inboxes.length > MAX_DIRECT_INBOXES) {
    throw new RangeError(`direct mailbox would retain ${next.inboxes.length} inboxes, above the ${MAX_DIRECT_INBOXES}-inbox bound`)
  }
  let previous = 0
  for (const message of next.messages) {
    if (message.seq <= previous || message.seq >= next.nextSeq) {
      throw new Error('direct mailbox ledger must hold strictly increasing sequences below its head')
    }
    previous = message.seq
    if (message.recipients.length === 0) throw new Error('direct mailbox message must retain an addressee')
    if (message.recipients.some(recipient => recipient.workspaceId === message.senderWorkspaceId)) {
      throw new Error('direct mailbox ledger must not hold same-workspace mail; that mail belongs to the v1 workspace queue')
    }
  }
}

/**
 * Host-owned durable direct mailbox. Every write serializes on one chain and
 * lands as a single global-record write, so a message, its recipient index
 * entries, and its cursors commit together or not at all.
 */
export class AgentDirectQueue extends Service {
  static inject = ['storageDomain', 'workspaceRegistry', 'agents']
  private state?: DomainGlobal<DirectQueueState>
  private operationTail: Promise<void> = Promise.resolve()
  private writing = false

  constructor(ctx: Context) { super(ctx, 'agentDirectQueue') }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentDirectQueueDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'agentDirectQueue.domainClose')
    this.state = domain.global
  }

  private record(): DirectQueueState {
    if (!this.state) throw new Error('agent direct queue is not initialized')
    // Before the first write the domain serves this spec's empty initial value.
    return this.state.get()
  }

  /**
   * Commit the complete ledger. This is the only writer: it runs inside the
   * serialized operation chain, and the reentrancy guard turns any future
   * unserialized caller into a loud failure instead of a lost update. The size
   * bound is applied here because only the final encoded record is bounded.
   * @param next - Full replacement ledger.
   */
  private async commit(next: DirectQueueState): Promise<void> {
    if (!this.state) throw new Error('agent direct queue is not initialized')
    if (this.writing) throw new Error('direct mailbox has a concurrent writer; ledger writes must serialize')
    const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8')
    if (bytes > MAX_DIRECT_LEDGER_BYTES) {
      throw new RangeError(`direct mailbox ledger would reach ${bytes} bytes, above the ${MAX_DIRECT_LEDGER_BYTES}-byte bound`)
    }
    verifyLedger(next)
    this.writing = true
    try { await this.state.set(next) } finally { this.writing = false }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(task)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Resolve the workspace of a prospective addressee. A live agent must pass
   * the same lineage rules as a sender; a session that is not live is eligible
   * only as a filtered member of some registered workspace.
   * @param id - Durable session id being addressed.
   * @returns the addressee's workspace, or `undefined` when unreachable.
   */
  private async recipientWorkspace(id: SessionId): Promise<Workspace | undefined> {
    const recipient = this.ctx.agents.get(id)
    if (recipient) return await resolveAuthorizedWorkspace(this.ctx, recipient)
    return this.ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds.includes(id))
  }

  /**
   * Report the caller's own cross-workspace address and unread depth.
   * @param agent - Exact live calling Agent.
   * @returns the caller's session address, workspace, cursor, and unread count.
   */
  async address(agent: Agent): Promise<DirectIdentity> {
    const workspace = await authorizeWorkspaceMember(this.ctx, agent)
    const state = this.record()
    const inboxCursor = state.inboxes.find(inbox => inbox.sessionId === agent.id)?.cursor ?? 0
    const unread = state.messages
      .filter(message => message.seq > inboxCursor && readableBy(message, agent.id, workspace.id)).length
    return { sessionId: agent.id, workspaceId: workspace.id, inboxCursor, unread }
  }

  /**
   * Send one direct message to session addresses in OTHER registered
   * workspaces. This ledger carries cross-workspace mail only: a recipient in
   * the sender's own workspace is rejected and belongs to `agentQueue.publish`,
   * whose v1 domain keeps every local direct message and topic.
   * @param agent - Exact live sending Agent.
   * @param request - Addressees and body.
   * @returns the committed canonical message.
   */
  async send(agent: Agent, request: DirectSendRequest): Promise<DirectMessage> {
    const workspace = await authorizeWorkspaceMember(this.ctx, agent)
    if (!request || !Array.isArray(request.recipients)) throw new TypeError('invalid direct recipients')
    const recipients = [...new Set(request.recipients)]
    if (recipients.some(id => typeof id !== 'string' || id.length === 0)) throw new TypeError('invalid direct recipient')
    if (recipients.length === 0) throw new Error('direct message needs at least one recipient')
    if (recipients.length > MAX_DIRECT_RECIPIENTS) throw new RangeError('direct message has too many recipients')
    const body = directMessage.shape.body.parse(request.body)
    return this.enqueue(async () => {
      // Recheck the sender and every addressee at the serialized write boundary.
      const senderWorkspace = await resolveAuthorizedWorkspace(this.ctx, agent)
      if (!senderWorkspace || senderWorkspace.id !== workspace.id || senderWorkspace.path !== workspace.path) {
        throw new Error('direct queue membership changed before sending')
      }
      const addresses: DirectAddress[] = []
      for (const recipient of recipients) {
        const target = await this.recipientWorkspace(recipient)
        if (!target) throw new Error('direct recipient does not belong to a registered workspace')
        if (target.id === senderWorkspace.id) {
          throw new Error('direct mailbox carries cross-workspace mail only; '
            + 'use agent_queue_send for a recipient in your own workspace')
        }
        addresses.push({ sessionId: recipient, workspaceId: target.id })
      }
      const state = this.record()
      const retained = this.retain(state)
      if (retained.length >= MAX_DIRECT_MESSAGES) {
        throw new RangeError('direct mailbox backlog is full; acknowledge messages before sending')
      }
      if (!Number.isSafeInteger(state.nextSeq + 1)) throw new RangeError('direct mailbox sequence exhausted')
      const message: DirectMessage = {
        id: randomUUID(), seq: state.nextSeq, sender: agent.id, senderWorkspaceId: senderWorkspace.id,
        recipients: addresses, body, createdAt: Date.now(),
      }
      const inboxes = this.index(state.inboxes, retained, addresses)
      if (inboxes.length > MAX_DIRECT_INBOXES) {
        throw new RangeError('direct recipient index is full; acknowledge messages before sending')
      }
      // Message, recipient index, and cursors share one durable global write.
      await this.commit({ nextSeq: state.nextSeq + 1, messages: [...retained, message], inboxes })
      return message
    })
  }

  /**
   * Retained messages: expired mail is dropped, and mail acknowledged by every
   * addressee is compacted. Unacknowledged mail is never silently dropped
   * before its retention ceiling.
   */
  private retain(state: DirectQueueState, now = Date.now()): DirectMessage[] {
    const cursors = new Map(state.inboxes.map(inbox => [inbox.sessionId, inbox.cursor] as const))
    return state.messages.filter(message =>
      now - message.createdAt < DIRECT_RETENTION_MS
      && message.recipients.some(recipient => (cursors.get(recipient.sessionId) ?? 0) < message.seq))
  }

  /**
   * Recipient index after a send: existing cursors are preserved, new
   * addressees gain a cursor at zero, and entries with no retained mail and no
   * acknowledged position are dropped.
   */
  private index(
    inboxes: readonly DirectInbox[],
    retained: readonly DirectMessage[],
    addresses: readonly DirectAddress[],
  ): DirectInbox[] {
    const live = new Set<SessionId>(retained.flatMap(message => message.recipients.map(entry => entry.sessionId)))
    const next = new Map<SessionId, DirectInbox>()
    for (const inbox of inboxes) {
      if (inbox.cursor === 0 && !live.has(inbox.sessionId)) continue
      next.set(inbox.sessionId, inbox)
    }
    for (const address of addresses) {
      const existing = next.get(address.sessionId)
      next.set(address.sessionId, existing
        ? { ...existing, workspaceId: address.workspaceId }
        : { sessionId: address.sessionId, workspaceId: address.workspaceId, cursor: 0 })
    }
    return [...next.values()]
  }

  /**
   * Read cross-workspace direct mail addressed to the caller, from its
   * acknowledged direct-inbox position by default. An explicit lower cursor
   * replays only still-retained messages and acknowledges nothing.
   * @param agent - Exact live reading Agent.
   * @param options - Optional explicit cursor and page limit (1–100, default 50).
   * @returns a bounded page plus the caller's durable `inboxCursor`.
   */
  async inbox(agent: Agent, options: { cursor?: number; limit?: number } = {}): Promise<DirectInboxPage> {
    const workspace = await authorizeWorkspaceMember(this.ctx, agent)
    const state = this.record()
    const inbox = state.inboxes.find(entry => entry.sessionId === agent.id)
    const after = options.cursor ?? inbox?.cursor ?? 0
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RangeError('direct inbox cursor must be a nonnegative safe integer')
    }
    const limit = bounded(options.limit ?? 50)
    const visible = state.messages
      .filter(message => message.seq > after && readableBy(message, agent.id, workspace.id))
    return { messages: visible.slice(0, limit), inboxCursor: inbox?.cursor ?? 0, hasMore: visible.length > limit }
  }

  /**
   * Advance only the caller's own direct-inbox cursor, monotonically and never
   * past the committed ledger head. It does not touch any v1 workspace cursor.
   * @param agent - Exact live acknowledging Agent.
   * @param throughSeq - Last processed sequence.
   * @returns the durable cursor after the acknowledgement.
   */
  async ackInbox(agent: Agent, throughSeq: number): Promise<number> {
    const workspace = await authorizeWorkspaceMember(this.ctx, agent)
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
      throw new RangeError('direct inbox cursor must be nonnegative')
    }
    return this.enqueue(async () => {
      const current = await resolveAuthorizedWorkspace(this.ctx, agent)
      if (!current || current.id !== workspace.id || current.path !== workspace.path) {
        throw new Error('direct queue membership changed before acknowledgment')
      }
      const state = this.record()
      if (throughSeq > state.nextSeq - 1) throw new RangeError('cannot acknowledge beyond committed direct mailbox head')
      const inbox = state.inboxes.find(entry => entry.sessionId === agent.id)
      if (!inbox) throw new Error('direct inbox has no addressed messages to acknowledge')
      if (throughSeq <= inbox.cursor) return inbox.cursor
      // A caller may acknowledge only mail it can currently read, so a session
      // that moved workspaces cannot retire mail addressed in its former one.
      const readable = state.messages
        .filter(message => readableBy(message, agent.id, current.id))
        .reduce((highest, message) => Math.max(highest, message.seq), 0)
      if (throughSeq > readable) {
        throw new RangeError('cannot acknowledge beyond direct mail readable in your current workspace')
      }
      const inboxes = state.inboxes.map(entry =>
        entry.sessionId === agent.id ? { ...entry, cursor: throughSeq } : entry)
      // Cursor advance and compaction of fully acknowledged mail commit together.
      const retained = this.retain({ ...state, inboxes })
      await this.commit({ ...state, messages: retained, inboxes })
      return throughSeq
    })
  }
}

export default AgentDirectQueue
