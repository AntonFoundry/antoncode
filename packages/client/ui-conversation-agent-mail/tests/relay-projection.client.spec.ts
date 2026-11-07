import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ConversationNodeAssembler, UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationNodeContext, ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createAgentMessage, createSettlementMessage } from '../../../subagent/subagent/src/continuation-messages.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  agentMailReceiveDefinition, agentMailRelayView, agentMailSendDefinition, agentMailQueueSendDefinition, registerAgentMailRelays,
} from '../src/client/relay-projection.ts'

function event<Type extends SessionEvent['type']>(type: Type, seq: number, data: SessionEvent<Type>['data']): SessionEvent<Type> {
  return { type, seq: SessionSeq(seq), time: seq * 1000, data,
    ...(type === 'user/message' || type === 'tool/result' ? { surfaceOp: 'append' as const } : {}),
  } as SessionEvent<Type>
}
function call(seq: number, id = 'send-1', args = JSON.stringify({ agent_id: 'child', message: 'Keep investigating' })) {
  return event('tool/call', seq, { turn: 1, step: 1, callId: ToolCallId(id), name: 'send_message', arguments: args })
}
function result(seq: number, id = 'send-1', isError = false, text = isError ? 'not accepted' : 'message delivered to agent child') {
  return event('tool/result', seq, { turn: 1, step: 1, message: createToolResultMessage({
    callId: ToolCallId(id), content: [{ type: 'text', text }], isError,
  }) })
}
function assembler() {
  const assembly = new ConversationNodeAssembler({
    entries: () => [agentMailSendDefinition, agentMailReceiveDefinition, agentMailQueueSendDefinition], fallbackEntry: () => undefined,
  }, { entries: () => [agentMailRelayView] })
  assembly.activateTarget('agent-mail')
  return assembly
}
function replace(assembly: ConversationNodeAssembler, events: readonly SessionEvent[]) {
  assembly.replaceWindow(events.map(value => ({ type: 'event' as const, event: value })), false)
  assembly.flush()
  return assembly.get('agent-mail')
}

const child = { id: 'child' as SessionId } as Agent

describe('Agent Mail durable relays', () => {
  it('replays successful outgoing agent_id calls and incoming child messages without repeating admission', () => {
    const incoming = createAgentMessage(child, [{ type: 'text', text: 'Evidence found' }])
    const events = [call(1), result(2), event('user/message', 3, incoming)]
    const assembly = assembler()
    const rows = replace(assembly, events)
    expect(rows).toEqual([
      { key: 'call:send-1', direction: 'outgoing', peer: 'child', body: 'Keep investigating', at: 1000 },
      { key: `message:${incoming.id}`, direction: 'incoming', peer: 'child', body: 'Agent child sent a message: \nEvidence found', at: 3000 },
    ])
    expect(replace(assembly, events)).toEqual(rows)
    expect(JSON.stringify(rows?.map(({ key: _key, ...row }) => row))).toMatchSnapshot()
  })

  it('preserves the exact admitted text blocks and maps a parent sender in a child session', () => {
    const parent = { id: 'parent' as SessionId } as Agent
    const message = createAgentMessage(parent, [{ type: 'text', text: 'Line one\nLine two' }])
    const rows = replace(assembler(), [event('user/message', 1, message)])
    expect(rows?.[0]).toMatchObject({ direction: 'incoming', peer: 'parent', body: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') })
  })

  it('excludes pending, failed, malformed, obsolete-argument and missing-call sends', () => {
    expect(replace(assembler(), [call(1)])).toEqual([])
    for (const args of ['{', 'null', '[]', '{}', '{"agent_id":4,"message":"x"}', '{"agent_id":"child","message":4}', '{"agent_id":"child","message":""}', '{"agent_id":"","message":"x"}', '{"subagent_id":"child","message":"old field"}']) {
      expect(replace(assembler(), [call(1, 'bad', args), result(2, 'bad')])).toEqual([])
    }
    expect(replace(assembler(), [call(1), result(2, 'send-1', true)])).toEqual([])
    expect(replace(assembler(), [result(2)])).toEqual([])
  })

  it('includes nested PTC send settlements once without requiring the enclosing run_code result', () => {
    const data = { rootCallId: ToolCallId('root'), parentCallId: ToolCallId('root'), subCallId: ToolCallId('nested'), name: 'send_message', arguments: { agent_id: 'parent', message: 'Nested reply' } }
    const start = event('tool/ptc-dispatch-start', 1, data)
    const done = event('tool/ptc-dispatch', 2, { ...data, isError: false, content: [] })
    expect(replace(assembler(), [start, done])).toEqual([{ key: 'call:nested', direction: 'outgoing', peer: 'parent', body: 'Nested reply', at: 2000 }])
    expect(replace(assembler(), [start, { ...done, data: { ...done.data, isError: true } }])).toEqual([])
    expect(replace(assembler(), [{ ...done, data: { ...done.data, name: 'bash' } }])).toEqual([])
  })

  it('does not credit runtime settlements or ordinary task prompts to the child', () => {
    const notice = createSettlementMessage(child.id, { output: [{ type: 'text', text: 'Closing answer' }], stopReason: 'completed' })
    expect(replace(assembler(), [event('user/message', 1, notice), event('user/message', 2, createUserMessage({ content: [{ type: 'text', text: 'Human prompt' }], source: { kind: 'user' } }))])).toEqual([])
  })

  it('keeps target snapshots unchanged for unrelated events and clears old-window mail on replacement', () => {
    const assembly = assembler()
    const rows = replace(assembly, [call(1), result(2)])
    assembly.append({ type: 'event', event: event('step/start', 3, { turn: 1, step: 2 }) })
    assembly.flush()
    expect(assembly.get('agent-mail')).toBe(rows)
    expect(replace(assembly, [])).toEqual([])
  })

  it('publishes newly settled and admitted messages incrementally and repairs a paged call head', () => {
    const assembly = assembler()
    replace(assembly, [call(1)])
    assembly.append({ type: 'event', event: result(2) })
    assembly.flush()
    expect(assembly.get('agent-mail')).toHaveLength(1)
    const incoming = createAgentMessage(child, [{ type: 'text', text: 'Update' }])
    const admitted = event('user/message', 3, incoming)
    assembly.append({ type: 'event', event: admitted })
    assembly.flush()
    expect(assembly.get('agent-mail')).toHaveLength(2)
    const before = assembly.get('agent-mail')
    assembly.append({ type: 'event', event: admitted })
    assembly.flush()
    expect(assembly.get('agent-mail')).toBe(before)
    const paged = assembler()
    expect(replace(paged, [result(2)])).toEqual([])
    paged.prepend([{ type: 'event', event: call(1) }], false)
    paged.flush()
    expect(paged.get('agent-mail')).toHaveLength(1)
  })

  it('does not turn malformed durable sender attribution or image blocks into authored text', () => {
    const message = createAgentMessage(child, [{ type: 'text', text: 'Update' }])
    for (const senderSessionId of ['', 4, undefined]) {
      const malformed = { ...message, source: { kind: 'agent-message', form: 'relay', senderSessionId } }
      expect(replace(assembler(), [event('user/message', 1, malformed as typeof message)])).toEqual([])
    }
    const image = createAgentMessage(child, [{ type: 'image', attachment: { attachmentId: 'attachment' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }])
    expect(replace(assembler(), [event('user/message', 1, image)])?.[0]?.body).toBe('Agent child sent a message: ')
  })

  it('keeps definition lifecycle delegation and target no-op updates stable', () => {
    const base = { key: 'key', kind: 'agent-mail', id: 'id', matches: [], start: undefined, state: undefined, current: new Map() }
    const start = (value: SessionEvent): ConversationStartMatch => ({ event: value, role: 'start', location: { kind: 'session' } })
    const reader = { previous: () => undefined }
    const send = { ...base, state: { accepted: false, relay: undefined } }
    expect(() => agentMailSendDefinition.start(base, start(event('step/start', 1, { turn: 1, step: 1 })), reader)).toThrow('requires a tool call')
    expect(agentMailSendDefinition.update(send, start(call(1)))).toBe(send.state)
    const receive = { ...base, state: null } satisfies ConversationNodeContext<null>
    expect(() => agentMailReceiveDefinition.start(receive, start(call(1)), reader)).toThrow('requires user/message')
    expect(agentMailReceiveDefinition.update(receive, start(call(1)))).toBeNull()
    const builder = agentMailRelayView.create()
    const timeline = { turnOrder: [], turns: new Map() }
    expect(builder.apply({ upserts: [], timeline })).toBe(builder.empty)
    const data = { key: 'call:id', direction: 'outgoing' as const, peer: 'child', body: 'Text', at: 0 }
    const node = { ...base, target: 'agent-mail', data }
    const first = builder.apply({ upserts: [node], timeline })
    expect(builder.apply({ upserts: [node], timeline })).toBe(first)
  })

  it('removes all contributed definitions and the target when its plugin unloads', async () => {
    const ctx = new Context()
    const conversation = new UiConversation(ctx, {} as never)
    const fiber = ctx.plugin({ inject: ['uiConversation'], apply: registerAgentMailRelays })
    await fiber.await()
    expect(conversation.events.entries()).toHaveLength(3)
    expect(conversation.views.entries()).toHaveLength(1)
    await fiber.dispose()
    expect(conversation.events.entries()).toHaveLength(0)
    expect(conversation.views.entries()).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})

function queueCall(seq: number, name = 'agent_queue_send') {
  return event('tool/call', seq, {
    turn: 1, step: 1, callId: ToolCallId('queue-call'), name,
    arguments: JSON.stringify({ recipients: ['draft-peer'], body: 'Draft argument, not the accepted result' }),
  })
}

const acceptedLocal = {
  id: 'local-message', seq: 42, workspaceId: 'workspace-a', sender: 'parent',
  recipients: ['child', 'sibling'], workspaceWide: true, body: 'Accepted local body', createdAt: 1234,
}
const acceptedDirect = {
  id: 'direct-message', seq: 43, senderWorkspaceId: 'workspace-a', sender: 'parent',
  recipients: [{ sessionId: 'remote-child', workspaceId: 'workspace-b' }],
  body: 'Accepted direct body', createdAt: 2345,
}
function queueResult(seq: number, value: unknown, isError = false) {
  return result(seq, 'queue-call', isError, JSON.stringify(value))
}

describe('Agent Mail durable queue sends', () => {
  it('projects accepted native workspace mail from the canonical result, including frozen broadcast recipients', () => {
    const rows = replace(assembler(), [queueCall(1), queueResult(2, acceptedLocal)])
    expect(rows).toEqual([{
      key: 'queue:local:local-message', direction: 'outgoing', channel: 'local', peer: 'child',
      recipients: ['child', 'sibling'], workspaceId: 'workspace-a', seq: 42,
      body: 'Accepted local body', at: 1234,
    }])
    expect(JSON.stringify(rows)).not.toContain('Draft argument')
    expect(JSON.stringify(rows)).toMatchSnapshot()
  })

  it('projects cross-workspace direct recipients from their accepted addresses and handles an empty local fanout', () => {
    expect(replace(assembler(), [queueCall(1, 'agent_queue_dm_send'), queueResult(2, acceptedDirect)])).toEqual([{
      key: 'queue:direct:direct-message', direction: 'outgoing', channel: 'direct', peer: 'remote-child',
      recipients: ['remote-child'], workspaceId: 'workspace-a', seq: 43,
      body: 'Accepted direct body', at: 2345,
    }])
    expect(replace(assembler(), [queueCall(1), queueResult(2, { ...acceptedLocal, recipients: [] })])?.[0])
      .toMatchObject({ peer: 'parent', recipients: [] })
  })

  it.each([['agent_queue_send', acceptedLocal], ['agent_queue_dm_send', acceptedDirect]] as const)('reconstructs successful nested PTC %s once without requiring an outer result', (name, accepted) => {
    const data = {
      rootCallId: ToolCallId('root'), parentCallId: ToolCallId('root'), subCallId: ToolCallId('nested-queue'),
      name, arguments: {}, content: [{ type: 'text' as const, text: JSON.stringify(accepted) }], isError: false,
    }
    const settled = event('tool/ptc-dispatch', 2, data)
    const assembly = assembler()
    expect(replace(assembly, [settled])).toHaveLength(1)
    assembly.append({ type: 'event', event: settled })
    assembly.flush()
    expect(assembly.get('agent-mail')).toHaveLength(1)
    expect(replace(assembler(), [{ ...settled, data: { ...data, isError: true } }])).toEqual([])
  })

  it('publishes queue settlements incrementally and repairs paged native call heads', () => {
    const assembly = assembler()
    expect(replace(assembly, [queueCall(1)])).toEqual([])
    assembly.append({ type: 'event', event: queueResult(2, acceptedLocal) })
    assembly.flush()
    expect(assembly.get('agent-mail')).toHaveLength(1)
    const paged = assembler()
    expect(replace(paged, [queueResult(2, acceptedLocal)])).toEqual([])
    paged.prepend([{ type: 'event', event: queueCall(1) }], false)
    paged.flush()
    expect(paged.get('agent-mail')).toHaveLength(1)
    expect(replace(paged, [])).toEqual([])
  })

  it('rejects canonical timestamps outside the Date range while retaining its valid upper boundary', () => {
    expect(replace(assembler(), [queueCall(1), queueResult(2, { ...acceptedLocal, createdAt: Number.MAX_SAFE_INTEGER })])).toEqual([])
    const maximumDate = new Date('+275760-09-13T00:00:00.000Z').getTime()
    expect(replace(assembler(), [queueCall(1), queueResult(2, { ...acceptedLocal, createdAt: maximumDate })])?.[0]?.at)
      .toBe(maximumDate)
  })

  it('excludes failed, pending, unpaired, truncated and malformed queue results', () => {
    expect(replace(assembler(), [queueCall(1)])).toEqual([])
    expect(replace(assembler(), [queueResult(2, acceptedLocal)])).toEqual([])
    expect(replace(assembler(), [queueCall(1), queueResult(2, acceptedLocal, true)])).toEqual([])
    for (const value of [null, {}, { ...acceptedLocal, seq: -1 }, { ...acceptedLocal, createdAt: 'yesterday' },
      { ...acceptedLocal, sender: '' }, { ...acceptedLocal, recipients: [4] }, { ...acceptedLocal, body: 4 },
      { ...acceptedDirect, recipients: [{ sessionId: 'child' }] }]) {
      expect(replace(assembler(), [queueCall(1), queueResult(2, value)])).toEqual([])
    }
    const truncated = queueResult(2, acceptedLocal)
    const malformed = { ...truncated, data: { ...truncated.data, message: { ...truncated.data.message, content: [{ type: 'text' as const, text: '{"id":"truncated' }] } } }
    expect(replace(assembler(), [queueCall(1), malformed])).toEqual([])
  })
})
