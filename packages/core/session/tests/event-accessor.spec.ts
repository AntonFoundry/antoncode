import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

describe('Session.eventAt', () => {
  it('reads appended events by log position with the same frozen objects as events', () => {
    const session = Session.create(SessionId('event-at'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/start', { turn: 2 })

    expect(session.eventAt(0)).toBe(session.events[0])
    expect(session.eventAt(1)).toBe(session.events[1])
    expect(session.eventAt(0)?.data).toEqual({ turn: 1 })
    expect(session.eventAt(1)?.data).toEqual({ turn: 2 })
  })

  it('returns undefined past the log end and sees appends immediately', () => {
    const session = Session.create(SessionId('event-at-end'))
    expect(session.eventAt(0)).toBeUndefined()

    session.append('turn/start', { turn: 1 })
    expect(session.eventAt(0)).toBeDefined()
    expect(session.eventAt(1)).toBeUndefined()
  })
})
