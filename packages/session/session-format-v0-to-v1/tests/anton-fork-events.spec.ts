import { describe, expect, it } from 'vitest'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { normalizeAntonForkV0Event } from '../src/anton-fork-events.ts'

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

  it('leaves upstream records untouched', () => {
    const todo = event('todo/write', { todos: [{ content: 'a', status: 'pending' }] })
    const descriptor = event('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'spawn' })
    const other = event('turn/start', { turn: 1 })
    for (const source of [todo, descriptor, other]) expect(normalizeAntonForkV0Event(source)).toBe(source)
  })
})
