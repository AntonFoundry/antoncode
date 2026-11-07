/** Incremental Agent Mail presentation of durable adjacent-Agent communications. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/client'
import type {
  ConversationNodeDefinition, ConversationViewDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** One accepted outgoing call or admitted incoming Agent message in the loaded window. */
export interface AgentMailRelay {
  readonly key: string
  readonly direction: 'incoming' | 'outgoing'
  readonly peer: string
  readonly body: string
  readonly at: number
}

interface SendState {
  readonly relay: AgentMailRelay | undefined
  readonly accepted: boolean
}

interface RelayNode extends ConversationViewNode {
  readonly data: AgentMailRelay
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Adjacent-Agent messages; queue delivery remains owned by the mail Remote. */
    'agent-mail': readonly AgentMailRelay[]
  }
}

/** Stable empty target before the view is activated. */
export const EMPTY_AGENT_MAIL_RELAYS: readonly AgentMailRelay[] = []

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function outgoing(value: unknown, key: string, at: number): AgentMailRelay | undefined {
  const args = record(value)
  if (typeof args?.['agent_id'] !== 'string' || args['agent_id'] === ''
    || typeof args['message'] !== 'string' || args['message'] === '') return undefined
  return { key, direction: 'outgoing', peer: args['agent_id'], body: args['message'], at }
}

/** Native and nested calls publish only after a successful durable settlement. */
export const agentMailSendDefinition: ConversationNodeDefinition<SendState> = {
  kind: 'agent-mail-send',
  target: 'agent-mail',
  match: (event) => {
    if (event.type === 'tool/call' && event.data.name === 'send_message') {
      return { id: String(event.data.callId), role: 'start' }
    }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') return { id: String(event.data.message.source.callId), role: 'update' }
    if (event.type === 'tool/ptc-dispatch' && event.data.name === 'send_message') {
      return { id: String(event.data.subCallId), role: 'start' }
    }
    return null
  },
  start: (_context, match) => {
    const event = match.event
    if (event.type === 'tool/ptc-dispatch') {
      return { relay: outgoing(event.data.arguments, `call:${event.data.subCallId}`, event.time), accepted: !event.data.isError }
    }
    if (event.type !== 'tool/call') throw new Error('Agent Mail send start requires a tool call')
    let args: unknown
    try { args = JSON.parse(event.data.arguments) } catch (_error) {
      // Malformed model JSON is retained in the transcript, not represented as accepted mail.
      return { relay: undefined, accepted: false }
    }
    return { relay: outgoing(args, `call:${event.data.callId}`, event.time), accepted: false }
  },
  update: (context, match) => match.event.type === 'tool/result'
    ? { ...context.state, accepted: match.event.data.message.isError !== true } : context.state,
  buildViewNode: context => context.state?.accepted !== true || context.state.relay === undefined ? null : {
    key: context.key, id: context.id, kind: context.kind, target: 'agent-mail', data: context.state.relay,
  },
}

/** Recipient admission is the single display source; inbox insertion is not a second message. */
export const agentMailReceiveDefinition: ConversationNodeDefinition<AgentMailRelay | null> = {
  kind: 'agent-mail-receive',
  target: 'agent-mail',
  match: event => event.type === 'user/message' && event.surfaceOp === 'append' && record(event.data.source)?.['kind'] === 'agent-message'
    ? { id: String(event.data.id), role: 'start' } : null,
  start: (_context, match) => {
    const event = match.event
    if (event.type !== 'user/message') throw new Error('Agent Mail receive start requires user/message')
    const source = record(event.data.source)
    if (typeof source?.['senderSessionId'] !== 'string' || source['senderSessionId'] === '') return null
    return {
      key: `message:${event.data.id}`, direction: 'incoming', peer: source['senderSessionId'],
      body: event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
      at: event.time,
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state == null ? null : {
    key: context.key, id: context.id, kind: context.kind, target: 'agent-mail', data: context.state,
  },
}

/** Target-owned loaded-window index; unrelated streaming events never rebuild its rows. */
export const agentMailRelayView: ConversationViewDefinition<RelayNode, readonly AgentMailRelay[]> = {
  target: 'agent-mail',
  create: () => {
    let rows = new Map<string, AgentMailRelay>()
    let snapshot = EMPTY_AGENT_MAIL_RELAYS
    const materialize = (): readonly AgentMailRelay[] => {
      const next = [...rows.values()].sort((left, right) => left.at - right.at)
      if (next.length === snapshot.length && next.every((row, index) => {
        const previous = snapshot[index]
        return previous?.key === row.key && previous.direction === row.direction && previous.peer === row.peer
          && previous.body === row.body && previous.at === row.at
      })) return snapshot
      return snapshot = next
    }
    return {
      empty: snapshot,
      replace: ({ nodes }) => {
        rows = new Map(nodes.map(node => [node.key, node.data]))
        return materialize()
      },
      apply: ({ upserts }) => {
        let changed = false
        for (const node of upserts) {
          if (rows.get(node.key) === node.data) continue
          rows.set(node.key, node.data)
          changed = true
        }
        return changed ? materialize() : snapshot
      },
    }
  },
}

/**
 * Register replayable Mail rows without delivering input or changing Session history.
 * @param ctx - Client context owning Conversation registrations.
 */
export function registerAgentMailRelays(ctx: Context): void {
  ctx.uiConversation.events.register(agentMailSendDefinition)
  ctx.uiConversation.events.register(agentMailReceiveDefinition)
  ctx.uiConversation.views.register(agentMailRelayView)
}
