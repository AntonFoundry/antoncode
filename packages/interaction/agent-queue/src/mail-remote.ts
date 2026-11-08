/** Owner-facing Remote adapter for the durable Agent Mail queues. */
import { addAbortListener } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { authorizeWorkspaceMember, resolveAuthorizedWorkspace } from './membership.ts'

import type { AgentMailAddress, AgentMailPage, AgentMailInvalidation } from './mail-types.ts'

/** Browser actions on the workspace and cross-workspace queues. */
export class AgentMailRemote extends TypertRemoteService {
  static inject = ['typert', 'agents', 'workspaceRegistry', 'agentQueue', 'agentDirectQueue']
  private readonly lifetime = new AbortController()

  /** @param ctx - Host context with both durable mail queues. */
  constructor(ctx: Context) {
    super(ctx, 'agentMailRemote', { namespace: 'agentMail' })
    ctx.effect(() => () => this.lifetime.abort(), 'agentMail.watchLifetime')
  }

  private requireOwner(): void {
    const principal = this.ctx.invocation?.peer.principal
    // Trusted in-process calls have no invocation; Remote callers must be the owner.
    if (principal !== undefined && principal.kind !== 'owner') {
      throw new RemoteError('agent-mail/owner-required', 'Agent mail is available only to the owner', {
        operation: this.ctx.invocation?.request.method ?? 'watch',
      })
    }
  }

  private async peerKeys(agent: Agent): Promise<string> {
    const keys: string[] = []
    for (const candidate of this.ctx.agents.list()) {
      if (candidate === agent) continue
      try {
        const workspace = await resolveAuthorizedWorkspace(this.ctx, candidate)
        if (workspace) keys.push(JSON.stringify([workspace.id, candidate.id]))
      } catch (error) {
        // A concurrently removed or invalid lineage is not discoverable.
        if (this.ctx.agents.get(candidate.id) === candidate) {
          this.ctx.logger.debug('Agent mail peer is not eligible for discovery', error)
        }
      }
    }
    return keys.sort().join('\n')
  }

  /**
   * Observe addressed mailbox commits and eligible peer changes without subscribing,
   * acknowledging, loading Sessions, or waking Agents. Initial revision zero follows
   * observer installation; consumers then refetch address and the selected inbox.
   * A slow consumer retains one pending invalidation, never a message/event buffer.
   * Reconnect starts a fresh generation and must refetch from its initial frame.
   * @param sessionId - Owner-selected address; only the current live registry instance is accepted.
   * @param signal - Remote consumer lifetime.
   * @returns Generation-local revisions until cancellation, target disposal, or Remote unload.
   * @throws agent-mail/owner-required or agent-mail/address-changed when authority is lost.
   */
  @Remote({ mode: 'stream' })
  async *watch(sessionId: SessionId, signal: AbortSignal): AsyncIterable<AgentMailInvalidation> {
    this.requireOwner()
    const addressChanged = (): RemoteError<'agent-mail/address-changed'> =>
      new RemoteError('agent-mail/address-changed', 'Agent mail address changed; reopen mail for the current Session', { sessionId })
    const agent = this.ctx.agents.get(sessionId)
    if (!agent) throw addressChanged()
    const session = agent.session
    const workspace = await authorizeWorkspaceMember(this.ctx, agent)
    const targetLifetime = new AbortController()
    const lifetime = AbortSignal.any([signal, this.lifetime.signal, targetLifetime.signal])
    if (lifetime.aborted) return
    let update = Promise.withResolvers<void>()
    let mailChanged = true
    let rosterChanged = true
    const changed = (): void => { mailChanged = true; update.resolve() }
    const roster = (): void => { rosterChanged = true; update.resolve() }
    const disposers: (() => void)[] = []
    using _cancellation = addAbortListener(lifetime, () => { update.resolve() })
    let revision = 0
    let peers: string | undefined
    try {
      disposers.push(this.ctx.on('agent/created', () => { roster(); return undefined }, { global: true }))
      disposers.push(this.ctx.on('agent/disposed', ({ agent: disposed }) => {
        if (disposed === agent) targetLifetime.abort(addressChanged())
        else roster()
      }, { global: true }))
      disposers.push(this.ctx.on('session/disposed', (disposed) => {
        if (disposed === session) targetLifetime.abort(addressChanged())
      }, { global: true }))
      disposers.push(this.ctx.on('workspace/changed', roster))
      disposers.push(await this.ctx.agentQueue.observe(agent, changed, lifetime))
      disposers.push(await this.ctx.agentDirectQueue.observe(agent, changed, lifetime))
      while (!lifetime.aborted) {
        const refreshMail = mailChanged
        const refreshRoster = rosterChanged
        mailChanged = false
        rosterChanged = false
        update = Promise.withResolvers<void>()
        const nextPeers = refreshRoster ? await this.peerKeys(agent) : peers
        this.requireOwner()
        const current = await resolveAuthorizedWorkspace(this.ctx, agent).catch(() => undefined)
        if (!current || agent.session !== session || current.id !== workspace.id || current.path !== workspace.path) {
          throw addressChanged()
        }
        if (lifetime.aborted) return
        if (refreshMail || nextPeers !== peers) {
          peers = nextPeers
          yield { revision: revision++ }
        }
        // Changes during authorization or yield remain in the successor slot.
        if (mailChanged || rosterChanged) continue
        await update.promise
      }
    } finally {
      for (const dispose of disposers.reverse()) dispose()
      if (!signal.aborted && !this.lifetime.signal.aborted) targetLifetime.signal.throwIfAborted()
    }
  }

  /**
   * Discover the caller address and one page of authorized live peers.
   * @param agent - target Agent resolved from its Session identity.
   * @param peerCursor - Peer page cursor; omission starts a fresh walk.
   * @param signal - Optional request cancellation; omission reads without cancellation.
   * @returns address and discoverable peers.
   */
  @Remote
  async address(agent: Agent, peerCursor?: string, signal?: AbortSignal): Promise<AgentMailAddress> {
    this.requireOwner()
    signal?.throwIfAborted()
    const address = await this.ctx.agentDirectQueue.address(agent, peerCursor === undefined ? {} : { peerCursor })
    signal?.throwIfAborted()
    return address
  }

  /**
   * Read at most 100 retained messages without acknowledging them.
   * @param agent - Exact live recipient resolved from the requested Session.
   * @param channel - Workspace-local or cross-workspace direct mailbox.
   * @param cursor - Exclusive replay position; omission uses the durable acknowledgement cursor.
   * @param signal - Optional request cancellation; omission reads without cancellation.
   * @returns Addressed mail page; an absent local delivery account returns an empty page.
   */
  @Remote
  async inbox(agent: Agent, channel: 'local' | 'direct', cursor?: number, signal?: AbortSignal): Promise<AgentMailPage> {
    this.requireOwner()
    signal?.throwIfAborted()
    if (channel === 'local') {
      try {
        const page = await this.ctx.agentQueue.read(agent, { ...(cursor === undefined ? {} : { cursor }), limit: 100 })
        signal?.throwIfAborted()
        return {
          messages: page.messages.map(message => ({
            seq: message.seq, sender: message.sender, senderWorkspaceId: message.workspaceId,
            body: message.body, createdAt: message.createdAt,
          })), cursor: page.cursor, hasMore: page.hasMore,
        }
      } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof Error && error.message.includes('queue session has no addressed messages')) {
          return { messages: [], cursor: 0, hasMore: false }
        }
        throw error
      }
    }
    const page = await this.ctx.agentDirectQueue.inbox(agent, { ...(cursor === undefined ? {} : { cursor }), limit: 100 })
    signal?.throwIfAborted()
    return {
      messages: page.messages.map(message => ({
        seq: message.seq, sender: message.sender, senderWorkspaceId: message.senderWorkspaceId,
        body: message.body, createdAt: message.createdAt,
      })), cursor: page.inboxCursor, hasMore: page.hasMore,
    }
  }

  /**
   * Commit mail through the selected queue; direct mail rejects workspace broadcasts.
   * @param agent - sending Agent.
   * @param channel - delivery queue.
   * @param recipients - addressees.
   * @param body - mail text.
   * @param workspaceWide - local topic delivery.
   * @returns committed sequence.
   */
  @Remote
  async send(agent: Agent, channel: 'local' | 'direct', recipients: readonly SessionId[], body: string, workspaceWide?: boolean): Promise<{ seq: number }> {
    this.requireOwner()
    if (channel === 'local') {
      const sent = await this.ctx.agentQueue.publish(agent, { recipients, body, workspaceWide: workspaceWide ?? false })
      return { seq: sent.seq }
    }
    if (workspaceWide) throw new Error('cross-workspace direct mail cannot be a workspace broadcast')
    const sent = await this.ctx.agentDirectQueue.send(agent, { recipients, body })
    return { seq: sent.seq }
  }

  /**
   * Durably acknowledge only the caller's selected mailbox.
   * @param agent - Exact live recipient resolved from the requested Session.
   * @param channel - Workspace-local or cross-workspace direct mailbox.
   * @param throughSeq - Highest processed sequence in that mailbox.
   * @returns Committed monotonic cursor; queue authorization and sequence failures reject.
   */
  @Remote
  async ack(agent: Agent, channel: 'local' | 'direct', throughSeq: number): Promise<{ cursor: number }> {
    this.requireOwner()
    if (channel === 'direct') return { cursor: await this.ctx.agentDirectQueue.ackInbox(agent, throughSeq) }
    const identity = await this.ctx.agentQueue.identities(agent)
    return { cursor: await this.ctx.agentQueue.ack(agent, identity.workspaceId, throughSeq) }
  }
}

export default AgentMailRemote
