/** Owner-facing Remote adapter for the durable Agent Mail queues. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'


import type { AgentMailAddress, AgentMailPage } from './mail-types.ts'

/** Browser actions on the workspace and cross-workspace queues. */
export class AgentMailRemote extends TypertRemoteService {
  static inject = ['typert', 'agents', 'agentQueue', 'agentDirectQueue']

  /** @param ctx - Host context with both durable mail queues. */
  constructor(ctx: Context) {
    super(ctx, 'agentMailRemote', { namespace: 'agentMail' })
  }

  /**
   * Discover the caller address and one page of authorized live peers.
   * @param agent - target Agent resolved from its Session identity.
   * @param peerCursor - peer page cursor.
   * @returns address and discoverable peers.
   */
  @Remote
  address(agent: Agent, peerCursor?: string): Promise<AgentMailAddress> {
    return this.ctx.agentDirectQueue.address(agent, peerCursor === undefined ? {} : { peerCursor })
  }

  /**
   * Read at most 100 retained messages without acknowledging them.
   * @param agent - Exact live recipient resolved from the requested Session.
   * @param channel - Workspace-local or cross-workspace direct mailbox.
   * @param cursor - Exclusive replay position; omission uses the durable acknowledgement cursor.
   * @returns Addressed mail page; an absent local delivery account returns an empty page.
   */
  @Remote
  async inbox(agent: Agent, channel: 'local' | 'direct', cursor?: number): Promise<AgentMailPage> {
    if (channel === 'local') {
      try {
        const page = await this.ctx.agentQueue.read(agent, { ...(cursor === undefined ? {} : { cursor }), limit: 100 })
        return {
          messages: page.messages.map(message => ({
            seq: message.seq, sender: message.sender, senderWorkspaceId: message.workspaceId,
            body: message.body, createdAt: message.createdAt,
          })), cursor: page.cursor, hasMore: page.hasMore,
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('queue session has no addressed messages')) {
          return { messages: [], cursor: 0, hasMore: false }
        }
        throw error
      }
    }
    const page = await this.ctx.agentDirectQueue.inbox(agent, { ...(cursor === undefined ? {} : { cursor }), limit: 100 })
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
    if (channel === 'direct') return { cursor: await this.ctx.agentDirectQueue.ackInbox(agent, throughSeq) }
    const identity = await this.ctx.agentQueue.identities(agent)
    return { cursor: await this.ctx.agentQueue.ack(agent, identity.workspaceId, throughSeq) }
  }
}

export default AgentMailRemote
