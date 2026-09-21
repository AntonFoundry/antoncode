import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as ResumeInvariant from '@deepseek-ai/dsh-resume-note/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ResumeInvariant)
  return ctx
}

function noteEvent(text = '[harness] note'): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: 0,
    time: 0,
    data: createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'resume-note',
        form: 'notice',
        summary: 'previous turn was interrupted by a harness restart',
      },
    }),
  } as SessionEvent<'user/message'>
}

function endEvent(turn: number, kind: 'interrupted' | 'stop'): SessionEvent<'turn/end'> {
  return {
    type: 'turn/end',
    seq: 0,
    time: 0,
    data: { turn, reason: kind === 'interrupted' ? { kind: 'interrupted' } : { kind: 'stop' } },
  } as SessionEvent<'turn/end'>
}

function sessionWith(...events: SessionEvent[]): Session {
  const session = Session.create(SessionId('resume-invariant'))
  for (const event of events) {
    if (event.type === 'user/message') session.append(event.type, event.data, { surfaceOp: 'append' })
    else session.append(event.type, event.data)
  }
  return session
}

describe('resume-note invariants', () => {
  it('accepts a note whose nearest earlier turn/end is interrupted', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', sessionWith(endEvent(1, 'interrupted')), noteEvent())
    }).not.toThrow()
  })

  it('rejects a note after a normally completed turn', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', sessionWith(endEvent(1, 'stop')), noteEvent())
    }).toThrow(/interrupted/)
  })

  it('rejects a note with no earlier turn/end', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', sessionWith(), noteEvent()) }).toThrow(/interrupted/)
  })

  it('rejects a second note for the same interruption', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit(
        'session/event',
        sessionWith(endEvent(1, 'interrupted'), noteEvent(), noteEvent('again')),
        noteEvent('again'),
      )
    }).toThrow(/at most once/)
  })
})
