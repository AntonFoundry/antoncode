/** Model-facing tools for the host-owned workspace agent queue. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-queue'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

export const name = 'tool-agent-queue'
export const inject = ['tools', 'agentQueue']

const MAX_BODY = 65536
const MAX_RECIPIENTS = 32
const MAX_READ = 100
const DIGEST_MESSAGES = 8
const DIGEST_BODY_CHARS = 400
const DIGEST_CHARS = 3600

function caller(agent: Agent | undefined): Agent {
  if (!agent) throw new Error('agent queue tools require a calling agent (exec.agent was undefined)')
  return agent
}

function workspace(value: string | undefined): string | undefined {
  if (value !== undefined && (!value.trim() || value.length > 256)) {
    throw new Error('workspace_id must be a nonempty identifier of at most 256 characters')
  }
  return value
}

function positiveCursor(value: number | undefined, label: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label} must be a nonnegative safe integer`)
  }
  return value
}

function render(value: unknown): { type: 'text'; text: string }[] {
  // Service returns owned queue projections, never live Cordis objects. Bound
  // model output independently of storage so a busy workspace cannot flood it.
  return [{ type: 'text', text: JSON.stringify(value).slice(0, 16000) }]
}

const result = { schema: { type: 'object', additionalProperties: true } as const, render: (_args: unknown, value: unknown) => render(value) }

/**
 * Keep acknowledgement explicit: the digest is a bounded, replayable view of
 * unread messages, not a delivery receipt. Never mutate the Agent inbox or
 * wake a turn from this listener.
 */
export function installQueueDigest(ctx: Context): () => void {
  return ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter' || step !== 1 || signal.aborted || decision.messages.length === 0) return decision
    let page: Awaited<ReturnType<typeof ctx.agentQueue.read>>
    try {
      page = await ctx.agentQueue.read(agent, { limit: DIGEST_MESSAGES })
    } catch {
      // An agent without a workspace or addressed messages still keeps the
      // proposed step. The explicit queue tools surface authorization errors.
      return decision
    }
    if (signal.aborted || page.messages.length === 0) return decision
    const lines = page.messages.map(message =>
      `#${message.seq} from ${message.sender}: ${message.body.slice(0, DIGEST_BODY_CHARS)}`)
    const text = `Unread workspace queue (acknowledged through #${page.cursor}; replayed until agent_queue_ack):\n`
      + `${lines.join('\n')}\n`
      + `${page.hasMore ? 'More messages remain; call agent_queue_read for the next page.\n' : ''}`
      + 'Call agent_queue_read for full messages and agent_queue_ack only after processing them.'
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: text.slice(0, DIGEST_CHARS) }],
        source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'unread agent queue messages' },
      })],
    }
  }, { prepend: true })
}

/** Register once on the host so both root and child agent tool scopes inherit these names. */
export function apply(ctx: Context): void {
  installQueueDigest(ctx)
  ctx.tools.register(defineTool({
    name: 'agent_queue_address',
    description: 'Show your exact session address and available workspace queue identities. Share the session id with agents in the same workspace when addressing a message.',
    parameters: {},
    output: result,
    async execute(_args, exec) {
      const identity = await ctx.agentQueue.identities(caller(exec.agent))
      return { sessionId: identity.sessionId, workspaceId: identity.workspaceId, sessionIds: [...identity.sessionIds] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_queue_subscribe',
    description: 'Subscribe your session to a workspace queue. This stores an independent durable read cursor; it does not wake or interrupt model turns.',
    parameters: {
      workspace_id: { type: 'string', required: true, description: 'Workspace id from agent_queue_address.' },
    },
    output: result,
    async execute(args, exec) {
      const agent = caller(exec.agent)
      workspace(args.workspace_id)
      await ctx.agentQueue.subscribe(agent, WorkspaceId(args.workspace_id))
      return { subscribed: true, workspaceId: args.workspace_id }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_queue_send',
    description: 'Publish a message within your workspace to up to 32 session addresses, the workspace stream, or both. Durable delivery does not wake or interrupt recipients.',
    parameters: {
      workspace_id: { type: 'string', description: 'Optional workspace id; defaults to your current workspace.' },
      recipients: { type: 'array', items: { type: 'string' }, description: 'Optional session ids of recipients in this workspace (maximum 32).' },
      workspace_wide: { type: 'boolean', description: 'Publish to all subscribed workspace sessions as well as any direct recipients.' },
      body: { type: 'string', required: true, description: 'Message text (maximum 65536 characters).' },
    },
    output: result,
    async execute(args, exec) {
      const agent = caller(exec.agent)
      if (!args.body.trim() || args.body.length > MAX_BODY) {
        throw new Error(`body must contain text and be at most ${MAX_BODY} characters`)
      }
      const recipients = args.recipients ?? []
      if (recipients.length > MAX_RECIPIENTS || recipients.some(id => !id.trim() || id.length > 256)) {
        throw new Error(`recipients must contain at most ${MAX_RECIPIENTS} nonempty session ids of at most 256 characters`)
      }
      if (new Set(recipients).size !== recipients.length) throw new Error('recipients must not repeat a session id')
      if (!recipients.length && args.workspace_wide !== true) {
        throw new Error('provide at least one recipient or set workspace_wide to true')
      }
      workspace(args.workspace_id)
      return await ctx.agentQueue.publish(agent, {
        ...(args.workspace_id === undefined ? {} : { workspaceId: WorkspaceId(args.workspace_id) }),
        recipients: recipients.map(SessionId),
        workspaceWide: args.workspace_wide ?? false,
        body: args.body,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'agent_queue_read',
    description: 'Read addressed and subscribed workspace messages from a cursor, without waking another agent. Acknowledge only after consuming the results.',
    parameters: {
      workspace_id: { type: 'string', description: 'Optional workspace id; defaults to your current workspace.' },
      cursor: { type: 'integer', description: 'Optional nonnegative stream sequence; defaults to your acknowledged cursor.' },
      limit: { type: 'integer', description: 'Maximum messages, from 1 to 100 (default set by service).' },
    },
    output: result,
    async execute(args, exec) {
      const agent = caller(exec.agent)
      const cursor = positiveCursor(args.cursor, 'cursor')
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > MAX_READ)) {
        throw new Error(`limit must be an integer from 1 to ${MAX_READ}`)
      }
      workspace(args.workspace_id)
      const page = await ctx.agentQueue.read(agent, {
        ...(args.workspace_id === undefined ? {} : { workspaceId: WorkspaceId(args.workspace_id) }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      return {
        messages: page.messages.map(message => ({ ...message, recipients: [...message.recipients] })),
        cursor: page.cursor,
        hasMore: page.hasMore,
      }
    },
  }))

  // Token economy: the mailbox exists so agents share one context instead of
  // rediscovering the same work. Guidance is registered only when the prompt
  // service is mounted; the tools remain usable without it.
  const prompt = ctx.get('systemPrompt' as never) as unknown as {
    section(options: { name: string; order: number; text: string }): unknown
  } | undefined
  prompt?.section({
    name: 'tool:agent-queue',
    order: 116.6,
    text: 'Workspace mailbox: subscribe once with agent_queue_subscribe, then read unread mail with '
      + 'agent_queue_read before starting new work; acknowledge with agent_queue_ack only after processing. '
      + 'Announce what you are about to take on with agent_queue_send (workspace_wide: true) so another agent '
      + 'does not duplicate it, and publish findings there so the group shares one context instead of '
      + 'rediscovering them. Address one agent directly with recipients. Mail is durable and never interrupts '
      + 'a turn; do not poll it in a loop.',
  })

  ctx.tools.register(defineTool({
    name: 'agent_queue_ack',
    description: 'Advance your durable subscription cursor after reading messages. Does not remove another recipient’s messages or wake agents.',
    parameters: {
      workspace_id: { type: 'string', required: true, description: 'Workspace id for your subscription.' },
      through_seq: { type: 'integer', required: true, description: 'Last processed nonnegative stream sequence.' },
    },
    output: result,
    async execute(args, exec) {
      const agent = caller(exec.agent)
      positiveCursor(args.through_seq, 'through_seq')
      workspace(args.workspace_id)
      return { cursor: await ctx.agentQueue.ack(agent, WorkspaceId(args.workspace_id), args.through_seq) }
    },
  }))
}
