/**
 * Model-facing direct-message tools over the host `agentDirectQueue` service.
 * These contracts are cross-workspace and session-addressed only: they carry
 * no workspace id, no stream, and no broadcast. The workspace-scoped
 * `agent_queue_*` tools in this package's main entry remain unchanged.
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
    description: 'Show your own direct-message address and how many direct messages are unread. Other agents address you by this session id, from any workspace.',
    parameters: {},
    output: result,
    async execute(_args, exec) {
      const identity = await ctx.agentDirectQueue.address(caller(exec.agent))
      return {
        sessionId: identity.sessionId, workspaceId: identity.workspaceId,
        cursor: identity.cursor, unread: identity.unread,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_queue_dm_send',
    description: 'Send one direct message to up to 32 agent session addresses, including agents working in other workspaces. Delivery is durable and does not wake or interrupt a recipient.',
    parameters: {
      recipients: {
        type: 'array', items: { type: 'string' }, required: true,
        description: 'Session ids to address (maximum 32); recipients may be in any workspace.',
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
    description: 'Read direct messages addressed to you from any workspace, starting after your acknowledged position. Acknowledge only after processing them.',
    parameters: {
      cursor: { type: 'integer', description: 'Optional nonnegative sequence to read after; defaults to your acknowledged position.' },
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
        cursor: page.cursor,
        hasMore: page.hasMore,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_queue_inbox_ack',
    description: 'Advance your durable direct-message position after processing messages. It never removes another agent’s copy and never wakes an agent.',
    parameters: {
      through_seq: { type: 'integer', required: true, description: 'Last processed nonnegative direct-message sequence.' },
    },
    output: result,
    async execute(args, exec) {
      const agent = caller(exec.agent)
      if (!Number.isSafeInteger(args.through_seq) || args.through_seq < 0) {
        throw new Error('through_seq must be a nonnegative safe integer')
      }
      return { cursor: await ctx.agentDirectQueue.ackInbox(agent, args.through_seq) }
    },
  }))
}
