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
import { MailQueueObservers, type MailQueueListener } from './observation.ts'
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
/**
 * Maximum peers reported by ONE discovery page. Discovery is keyset-paged, not
 * capped: this bounds a single response, never the number of peers a caller can
 * reach by walking `nextPeerCursor` to exhaustion.
 */
export const MAX_DIRECT_PEER_PAGE = 128
/** Peers per discovery page when the caller names no `peerLimit`. */
export const DEFAULT_DIRECT_PEER_PAGE = 50
/** Maximum addressees per direct send. */
export const MAX_DIRECT_RECIPIENTS = 32
/** Maximum body length in UTF-16 code units. */
export const MAX_DIRECT_BODY_LENGTH = 65536
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

/**
 * One discoverable peer: a live Agent whose own lineage authorizes a registered
 * workspace. `transport` names the service that actually reaches it, so a
 * caller never sends a local message through the cross-workspace ledger.
 */
export interface DirectPeer {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  readonly transport: 'direct' | 'workspace-queue'
}

/**
 * The caller's own cross-workspace address, direct-inbox position, unread
 * depth, and ONE keyset page of the live peers it may address.
 * `hasMorePeers` reports that live peers remain beyond this page, and
 * `nextPeerCursor` — present exactly when `hasMorePeers` is true — resumes the
 * walk strictly after the last peer returned.
 */
export interface DirectIdentity {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  readonly inboxCursor: number
  readonly unread: number
  readonly peers: readonly DirectPeer[]
  readonly hasMorePeers: boolean
  readonly nextPeerCursor?: string
}

/** Optional peer-page controls of one `address` call. */
export interface DirectAddressOptions {
  /** Opaque `nextPeerCursor` of a previous page; the walk resumes after it. */
  readonly peerCursor?: string
  /** Peers per page, 1–{@link MAX_DIRECT_PEER_PAGE}. */
  readonly peerLimit?: number
}

const bounded = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('direct inbox limit must be an integer between 1 and 100')
  }
  return limit
}

/**
 * Sort key of one peer. Discovery orders by `(workspaceId, sessionId)`, so the
 * key that a cursor encodes is exactly the pair that orders the page: the walk
 * stays stable and gapless even as peers appear and disappear between calls.
 * @param peer - Peer whose ordering key is needed.
 * @returns the comparable key of that peer.
 */
const peerKey = (peer: { workspaceId: WorkspaceId; sessionId: SessionId }): [string, string] =>
  [peer.workspaceId, peer.sessionId]

/** Lexicographic comparison of two peer keys; the sole ordering of discovery. */
const comparePeerKeys = (left: readonly [string, string], right: readonly [string, string]): number =>
  left[0].localeCompare(right[0]) || left[1].localeCompare(right[1])

/**
 * Encode one peer position as an opaque resumption token. The encoding is
 * deliberately opaque so a caller treats it as a position, not as an address it
 * may synthesize.
 * @param peer - Last peer of the page just returned.
 * @returns the cursor resuming strictly after that peer.
 */
const encodePeerCursor = (peer: DirectPeer): string =>
  Buffer.from(JSON.stringify(peerKey(peer)), 'utf8').toString('base64url')

/**
 * Decode a peer cursor back to its ordering key. Anything that is not a token
 * this service issued — wrong encoding, wrong shape, empty parts — is rejected
 * loudly rather than silently restarting the walk at the beginning, which would
 * make a caller re-read peers it already handled and believe it had finished.
 * @param cursor - Opaque token from a previous `nextPeerCursor`.
 * @returns the decoded ordering key.
 */
function decodePeerCursor(cursor: string): [string, string] {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 4096) {
    throw new RangeError('direct peer cursor must be a token returned by a previous discovery page')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new RangeError('direct peer cursor must be a token returned by a previous discovery page')
  }
  if (!Array.isArray(parsed) || parsed.length !== 2
    || parsed.some(part => typeof part !== 'string' || part.length === 0)) {
    throw new RangeError('direct peer cursor must be a token returned by a previous discovery page')
  }
  return [parsed[0] as string, parsed[1] as string]
}

/** Bound one peer page size; the ceiling bounds a response, never the walk. */
const boundedPeerPage = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DIRECT_PEER_PAGE) {
    throw new RangeError(`direct peer limit must be an integer between 1 and ${MAX_DIRECT_PEER_PAGE}`)
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
 * Index key of one address. Cursors are keyed by the same `(sessionId,
 * workspaceId)` pair the address freezes, never by the session alone: a
 * session-global position would let an acknowledgement earned in one workspace
 * hide older unacknowledged mail addressed to it in another.
 */
const addressKey = (address: { sessionId: SessionId; workspaceId: WorkspaceId }): string =>
  JSON.stringify([address.sessionId, address.workspaceId])

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
  private readonly observers: MailQueueObservers
  private writing = false

  constructor(ctx: Context) {
    super(ctx, 'agentDirectQueue')
    this.observers = new MailQueueObservers(ctx)
    ctx.effect(() => () => this.observers.dispose(), 'agentDirectQueue.observers')
  }

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

  /**
   * Observe only addressed committed sends and cursor advances without changing durable state.
   * Install before reading to close the registration/read race. Unlike subscribe, this
   * never creates an account or opts the caller into broadcasts.
   * @param agent - Exact live recipient, reauthorized at the serialized registration point.
   * @param listener - Post-commit invalidation callback; errors are contained and logged.
   * @param signal - Optional cancellation; omission requires explicit disposal.
   * @returns Idempotent observer disposer; no durable delivery state is changed.
   */
  observe(agent: Agent, listener: MailQueueListener, signal?: AbortSignal): Promise<() => void> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      const workspace = await authorizeWorkspaceMember(this.ctx, agent)
      return this.observers.add(agent, workspace, listener, signal)
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(task)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Resolve the workspace of a prospective addressee. The addressee must be an
   * exact live Agent that passes the same lineage rules as a sender, so sender
   * and recipient authorization are identical. Registry membership alone is
   * deliberately not accepted: a durable member list can outlive the session's
   * real permissions, and mail no live agent can currently receive would only
   * occupy the bounded ledger.
   * @param id - Durable session id being addressed.
   * @returns the addressee's authorized workspace, or `undefined` when unreachable.
   */
  private async recipientWorkspace(id: SessionId): Promise<Workspace | undefined> {
    const recipient = this.ctx.agents.get(id)
    if (!recipient) return undefined
    return await resolveAuthorizedWorkspace(this.ctx, recipient)
  }

  /**
   * Discover every live peer this caller may address, across all registered
   * workspaces: roots, their subagents, and siblings alike.
   *
   * Only live registry identities are reported. A session appears when it is an
   * exact live Agent whose own lineage authorizes a registered workspace — the
   * same rule `send` applies — so offline sessions, sessions with an
   * unregistered working directory, and broken lineages stay invisible, and no
   * working directory, transcript, or header detail is exposed. A peer in the
   * caller's own workspace is reported with the `workspace-queue` transport,
   * because its mail belongs to `agentQueue.publish`, not to this ledger.
   * Discovery is keyset-paged over the `(workspaceId, sessionId)` order: one
   * page is bounded, the walk is not, so a caller reaches EVERY live peer by
   * following `nextPeerCursor` instead of silently losing peers past a cap.
   * @param agent - Exact live calling Agent.
   * @param workspaceId - The caller's already authorized workspace.
   * @param options - Optional resumption cursor and page size.
   * @returns one page of peers plus its continuation.
   */
  private async discover(
    agent: Agent,
    workspaceId: WorkspaceId,
    options: DirectAddressOptions = {},
  ): Promise<{ peers: DirectPeer[]; hasMorePeers: boolean; nextPeerCursor?: string }> {
    const limit = boundedPeerPage(options.peerLimit ?? DEFAULT_DIRECT_PEER_PAGE)
    const after = options.peerCursor === undefined ? undefined : decodePeerCursor(options.peerCursor)
    const found = new Map<SessionId, DirectPeer>()
    for (const candidate of this.ctx.agents.list()) {
      if (candidate.id === agent.id || found.has(candidate.id)) continue
      let authorized: Workspace | undefined
      try {
        authorized = await resolveAuthorizedWorkspace(this.ctx, candidate)
      } catch {
        // One forged or half-disposed lineage must not hide every other peer.
        continue
      }
      if (!authorized) continue
      found.set(candidate.id, {
        sessionId: candidate.id,
        workspaceId: authorized.id,
        transport: authorized.id === workspaceId ? 'workspace-queue' : 'direct',
      })
    }
    const ordered = [...found.values()]
      .sort((left, right) => comparePeerKeys(peerKey(left), peerKey(right)))
      .filter(peer => after === undefined || comparePeerKeys(peerKey(peer), after) > 0)
    const peers = ordered.slice(0, limit)
    const hasMorePeers = ordered.length > peers.length
    const last = peers.at(-1)
    return {
      peers,
      hasMorePeers,
      ...hasMorePeers && last ? { nextPeerCursor: encodePeerCursor(last) } : {},
    }
  }

  /**
   * Report the caller's own address, unread depth, and the live peers it may
   * address in every registered workspace, one keyset page at a time.
   * @param agent - Exact live calling Agent.
   * @param options - Optional peer resumption cursor and page size.
   * @returns the caller's address, cursor, unread count, and one peer page.
   */
  async address(agent: Agent, options: DirectAddressOptions = {}): Promise<DirectIdentity> {
    const workspace = await authorizeWorkspaceMember(this.ctx, agent)
    const state = this.record()
    const key = addressKey({ sessionId: agent.id, workspaceId: workspace.id })
    const inboxCursor = state.inboxes.find(inbox => addressKey(inbox) === key)?.cursor ?? 0
    const unread = state.messages
      .filter(message => message.seq > inboxCursor && readableBy(message, agent.id, workspace.id)).length
    const page = await this.discover(agent, workspace.id, options)
    return {
      sessionId: agent.id, workspaceId: workspace.id, inboxCursor, unread,
      peers: page.peers, hasMorePeers: page.hasMorePeers,
      ...page.nextPeerCursor === undefined ? {} : { nextPeerCursor: page.nextPeerCursor },
    }
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
    if (!Array.isArray(request.recipients)) throw new TypeError('invalid direct recipients')
    const recipients = [...new Set<SessionId>(request.recipients)]
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
        if (!target) {
          throw new Error('direct recipient must be a live agent authorized in a registered workspace')
        }
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
      for (const recipient of message.recipients) {
        await this.observers.notify(recipient.workspaceId, recipient.sessionId, message.seq)
      }
      return message
    })
  }

  /**
   * Retained messages. A durable acknowledgement by every frozen addressee is
   * the ONLY way a message leaves this ledger: there is no age ceiling, so no
   * unacknowledged mail is ever silently destroyed. Growth is bounded by
   * rejecting the send instead — by retained count, index size, and encoded
   * record bytes — exactly as the v1 workspace queue rejects on a full backlog.
   * @param state - Ledger to compact.
   * @returns the messages that must still be retained.
   */
  private retain(state: DirectQueueState): DirectMessage[] {
    const cursors = new Map(state.inboxes.map(inbox => [addressKey(inbox), inbox.cursor] as const))
    return state.messages.filter(message =>
      message.recipients.some(recipient => (cursors.get(addressKey(recipient)) ?? 0) < message.seq))
  }

  /**
   * Recipient index after a send, keyed by the frozen address pair: existing
   * cursors are preserved, a newly addressed pair gains a cursor at zero, and
   * pairs with neither retained mail nor an acknowledged position are dropped.
   * @param inboxes - Current recipient index.
   * @param retained - Messages that survive compaction.
   * @param addresses - Addressees of the message being committed.
   * @returns the next recipient index.
   */
  private index(
    inboxes: readonly DirectInbox[],
    retained: readonly DirectMessage[],
    addresses: readonly DirectAddress[],
  ): DirectInbox[] {
    const live = new Set<string>(retained.flatMap(message => message.recipients.map(addressKey)))
    const next = new Map<string, DirectInbox>()
    for (const inbox of inboxes) {
      const key = addressKey(inbox)
      if (inbox.cursor === 0 && !live.has(key)) continue
      next.set(key, inbox)
    }
    for (const address of addresses) {
      const key = addressKey(address)
      if (!next.has(key)) {
        next.set(key, { sessionId: address.sessionId, workspaceId: address.workspaceId, cursor: 0 })
      }
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
    const key = addressKey({ sessionId: agent.id, workspaceId: workspace.id })
    const inbox = state.inboxes.find(entry => addressKey(entry) === key)
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
   * Advance the cursor of the caller's own `(session, current workspace)`
   * address, monotonically and never past the committed ledger head or the mail
   * it can currently read. It touches no other address and no v1 workspace cursor.
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
      const key = addressKey({ sessionId: agent.id, workspaceId: current.id })
      const inbox = state.inboxes.find(entry => addressKey(entry) === key)
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
        addressKey(entry) === key ? { ...entry, cursor: throughSeq } : entry)
      // Cursor advance and compaction of fully acknowledged mail commit together.
      const retained = this.retain({ ...state, inboxes })
      await this.commit({ ...state, messages: retained, inboxes })
      await this.observers.notify(current.id, agent.id, throughSeq)
      return throughSeq
    })
  }
}

export default AgentDirectQueue
