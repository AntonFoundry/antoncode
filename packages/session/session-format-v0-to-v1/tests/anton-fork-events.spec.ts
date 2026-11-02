import { describe, expect, it } from 'vitest'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import {
  ANTON_EMPTY_TOOL_CALL_NAME,
  AntonEmptyToolCallRepair,
  normalizeAntonForkV0Event,
} from '../src/anton-fork-events.ts'

const event = (type: string, data: SessionFormatEvent['data']): SessionFormatEvent => ({ type, seq: 3, time: 42, data })

describe('normalizeAntonForkV0Event', () => {
  it.each(['c0ntext/window', 'c0ntext/mirror-ack', 'c0ntext/page-enrichment', 'c0ntext/page-archive', 'plan/write'])(
    'carries the fork-only %s record unchanged except for ignorable', (type) => {
      const source = event(type, { anything: [1, { nested: true }] })
      expect(normalizeAntonForkV0Event(source)).toEqual({ ...source, ignorable: true })
    })

  it.each(['continuable', 'one-shot'])('renumbers a version-2 %s subagent descriptor to the released v3', (mode) => {
    const source = event('subagent/descriptor', { version: 2, mode, provider: 'spawn', label: 'child' })
    expect(normalizeAntonForkV0Event(source).data).toEqual({ version: 3, mode, provider: 'spawn', label: 'child' })
  })

  it('flattens Todo Tree children depth-first, drops fork-only members, and keeps cancelled visible', () => {
    const source = event('todo/write', { todos: [
      { content: 'ship', status: 'in_progress', priority: 'high', children: [
        { content: 'build', status: 'completed', children: [{ content: 'sign', status: 'cancelled' }] },
      ] },
      { content: 'docs', status: 'pending' },
    ] })
    expect(normalizeAntonForkV0Event(source).data).toEqual({ todos: [
      { content: 'ship', status: 'in_progress' },
      { content: '↳ build', status: 'completed' },
      { content: '  ↳ sign [cancelled]', status: 'completed' },
      { content: 'docs', status: 'pending' },
    ] })
  })

  it('passes malformed fork todos through for validation to reject', () => {
    const source = event('todo/write', { todos: ['text', { children: [{ status: 'pending' }] }] })
    expect(normalizeAntonForkV0Event(source).data).toEqual({ todos: [
      'text', { content: '', status: 'pending' }, { content: '↳ ', status: 'pending' },
    ] })
  })

  it('leaves upstream records untouched', () => {
    const todo = event('todo/write', { todos: [{ content: 'a', status: 'pending' }] })
    const descriptor = event('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'spawn' })
    const other = event('turn/start', { turn: 1 })
    for (const source of [todo, descriptor, other]) expect(normalizeAntonForkV0Event(source)).toBe(source)
  })
})

describe('AntonEmptyToolCallRepair', () => {
  const at = (seq: number, type: string, data: SessionFormatEvent['data']): SessionFormatEvent => ({ type, seq, time: 42, data })
  const call = (id: string, name: string) => ({ type: 'tool-call', id, name, arguments: '{}' })
  const result = (seq: number, callId: string) => at(seq, 'tool/result', {
    turn: 1, step: 2,
    message: { role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [], isError: true }] },
  })

  it('gives empty calls one id across the streamed block, message, call, and result, pairing in log order', () => {
    const repair = new AntonEmptyToolCallRepair()
    const blockEnd = repair.normalize(at(1, 'assistant/chunk', { turn: 1, step: 2, chunk: { type: 'block-end', index: 1, block: call('', '') } }))
    const message = repair.normalize(at(2, 'assistant/message', { turn: 1, step: 2, message: {
      role: 'assistant', content: [{ type: 'text', text: 'x' }, call('', ''), call('', ''), call('ok', 'bash')],
    } }))
    const events = [
      at(3, 'tool/call', { turn: 1, step: 2, callId: '', name: '', arguments: '{}' }), result(4, ''),
      at(5, 'tool/call', { turn: 1, step: 2, callId: '', name: '', arguments: '{}' }), result(6, ''),
    ].map(source => repair.normalize(source))
    const first = 'anton-empty-call-1-2-1'
    const second = 'anton-empty-call-1-2-2'
    expect(blockEnd.data).toMatchObject({ chunk: { block: { id: first, name: ANTON_EMPTY_TOOL_CALL_NAME } } })
    expect(message.data).toMatchObject({ message: { content: [{ type: 'text' }, { id: first }, { id: second }, { id: 'ok', name: 'bash' }] } })
    expect(events.map(e => e.data)).toMatchObject([
      { callId: first }, { message: { source: { callId: first }, content: [{ toolCallId: first }] } },
      { callId: second }, { message: { source: { callId: second }, content: [{ toolCallId: second }] } },
    ])
  })

  it('names a nameless call that already has an id, and drops a null delta name', () => {
    const repair = new AntonEmptyToolCallRepair()
    expect(repair.normalize(at(1, 'tool/call', { turn: 1, step: 1, callId: 'recovered-1', name: '', arguments: '' })).data)
      .toMatchObject({ callId: 'recovered-1', name: ANTON_EMPTY_TOOL_CALL_NAME })
    expect(repair.normalize(at(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: '', name: null, argumentsDelta: '{' } })).data)
      .toEqual({ turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{' } })
  })

  it('leaves an empty call id with no repaired id to take for validation to reject', () => {
    const source = at(1, 'tool/call', { turn: 1, step: 1, callId: '', name: 'bash', arguments: '' })
    expect(new AntonEmptyToolCallRepair().normalize(source).data).toMatchObject({ callId: '' })
    const orphan = result(2, '')
    expect(new AntonEmptyToolCallRepair().normalize(orphan)).toBe(orphan)
  })

  it('keeps the name of a named block whose id was empty', () => {
    const repaired = new AntonEmptyToolCallRepair().normalize(at(1, 'assistant/message', { turn: 2, step: 3, message: { role: 'assistant', content: [call('', 'bash')] } }))
    expect(repaired.data).toMatchObject({ message: { content: [{ id: 'anton-empty-call-2-3-0', name: 'bash' }] } })
  })

  it('names a nameless block that already has an id without queueing it for a call', () => {
    const repair = new AntonEmptyToolCallRepair()
    expect(repair.normalize(at(1, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [call('kept', '')] } })).data)
      .toMatchObject({ message: { content: [{ id: 'kept', name: ANTON_EMPTY_TOOL_CALL_NAME }] } })
    expect(repair.normalize(at(2, 'tool/call', { turn: 1, step: 1, callId: '', name: 'bash', arguments: '' })).data).toMatchObject({ callId: '' })
  })

  it('leaves records whose members are not the expected JSON types for validation to reject', () => {
    const repair = new AntonEmptyToolCallRepair()
    for (const source of [
      at(1, 'tool/call', 'not a record'),
      at(2, 'assistant/message', { turn: 1, step: 1, message: 'text' }),
      at(3, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: 'text' } }),
      at(4, 'assistant/chunk', { turn: 1, step: 1, chunk: 'text' }),
      at(5, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-end', index: '0', block: call('', '') } }),
      at(6, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '' } }),
      at(7, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '' } } }),
      at(8, 'tool/result', { turn: 1, step: 1, message: 'text' }),
      at(9, 'tool/result', { turn: 1, step: 1, message: { source: 'tool' } }),
      at(10, 'tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: '' }, content: [] } }),
      at(11, 'tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: '' }, content: ['text'] } }),
      at(12, 'tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: '' }, content: [{ type: 'tool-result', toolCallId: 'x' }] } }),
      at(13, 'user/message', { id: 'u' }),
    ]) expect(repair.normalize(source)).toBe(source)
  })

  it('leaves well-formed tool records untouched', () => {
    const repair = new AntonEmptyToolCallRepair()
    for (const source of [
      at(1, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [call('a', 'bash')] } }),
      at(2, 'tool/call', { turn: 1, step: 1, callId: 'a', name: 'bash', arguments: '' }),
      result(3, 'a'),
    ]) expect(repair.normalize(source)).toBe(source)
  })
})
