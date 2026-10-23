/**
 * Model-facing direct-message tools over the host `agentDirectQueue` service.
 * These contracts address sessions in OTHER workspaces only: they carry no
 * workspace id, no stream, and no broadcast, and a recipient in the caller's
 * own workspace is rejected in favor of `agent_queue_send`. The
 * workspace-scoped `agent_queue_*` tools in the main entry are unchanged.
 * @module @deepseek-ai/dsh-tool-agent-queue/direct
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-queue/direct'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-agent-queue-direct'
export const inject = ['tools', 'agentDirectQueue']

const MAX_BODY = 65536
const MAX_RECIPIENTS = 32
const MAX_READ = 100
const MAX_ID = 256

function caller(agent: Agent | undefined): Agent {
  if (!agent) throw new Error('direct message tools require a calling agent (exec.agent was undefined)')
  return agent
}

/** Bound model output independently of storage so a busy mailbox cannot flood it. */
const render = (value: unknown): { type: 'text'; text: string }[] =>
  [{ type: 'text', text: JSON.stringify(value).slice(0, 16000) }]

const result = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => render(value),
}

/** Register the direct-message tool names once on the host. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'agent_queue_dm_address',
    description: 'Show your own direct-message address, your direct-inbox position (inboxCursor), and how many cross-workspace direct messages are unread. Agents in other workspaces address you by this session id.',
    parameters: {},
    output: result,
    async execute(_args, exec) {
      const identity = await ctx.agentDirectQueue.address(caller(exec.agent))
      return {
        sessionId: identity.sessionId, workspaceId: identity.workspaceId,
        inboxCursor: identity.inboxCursor, unread: identity.unread,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_queue_dm_send',
    description: 'Send one direct message to up to 32 agent sessions working in OTHER workspaces. For a recipient in your own workspace use agent_queue_send instead. Delivery is durable and does not wake or interrupt a recipient.',
    parameters: {
      recipients: {
        type: 'array', items: { type: 'string' }, required: true,
        description: 'Session ids to address (maximum 32); every recipient must be in a workspace other than yours.',
      },
      body: { type: 'string', required: true, description: 'Message text (maximum 65536 characters).' },
    },
    output: result,
    async execute(args, exec) {
      const agent = caller(exec.agent)
      if (!args.body.trim() || args.body.length > MAX_BODY) {
        throw new Error(`body must contain text and be at most ${MAX_BODY} characters`)
      }
      const recipients = args.recipients
      if (!recipients.length || recipients.length > MAX_RECIPIENTS
        || recipients.some(id => !id.trim() || id.length > MAX_ID)) {
        throw new Error(`recipients must contain 1 to ${MAX_RECIPIENTS} nonempty session ids of at most ${MAX_ID} characters`)
      }
      if (new Set(recipients).size !== recipients.length) throw new Error('recipients must not repeat a session id')
      const message = await ctx.agentDirectQueue.send(agent, { recipients: recipients.map(SessionId), body: args.body })
      return { ...message, recipients: message.recipients.map(recipient => ({ ...recipient })) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_queue_inbox_read',
    description: 'Read cross-workspace direct messages addressed to you, starting after your direct-inbox position (inboxCursor), which is separate from any workspace queue cursor. Acknowledge only after processing them.',
    parameters: {
      cursor: { type: 'integer', description: 'Optional nonnegative direct-ledger sequence to read after; defaults to your acknowledged inboxCursor.' },
      limit: { type: 'integer', description: 'Maximum messages, from 1 to 100 (default set by service).' },
    },
    output: result,
    async execute(args, exec) {
      const agent = caller(exec.agent)
      if (args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || args.cursor < 0)) {
        throw new Error('cursor must be a nonnegative safe integer')
      }
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > MAX_READ)) {
        throw new Error(`limit must be an integer from 1 to ${MAX_READ}`)
      }
      const page = await ctx.agentDirectQueue.inbox(agent, {
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      return {
        messages: page.messages.map(message => ({
          ...message, recipients: message.recipients.map(recipient => ({ ...recipient })),
        })),
        inboxCursor: page.inboxCursor,
        hasMore: page.hasMore,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_queue_inbox_ack',
    description: 'Advance your durable direct-inbox position (inboxCursor) after processing direct messages. It leaves workspace queue cursors alone, never removes another agent’s copy, and never wakes an agent.',
    parameters: {
      through_seq: { type: 'integer', required: true, description: 'Last processed nonnegative direct-ledger sequence.' },
    },
    output: result,
    async execute(args, exec) {
      const agent = caller(exec.agent)
      if (!Number.isSafeInteger(args.through_seq) || args.through_seq < 0) {
        throw new Error('through_seq must be a nonnegative safe integer')
      }
      return { inboxCursor: await ctx.agentDirectQueue.ackInbox(agent, args.through_seq) }
    },
  }))
}
