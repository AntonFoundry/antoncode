import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

describe('Session.eventAt', () => {
  it('reads appended events by log position with the same frozen objects as events', () => {
    const session = Session.create(SessionId('event-at'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/start', { turn: 2 })

    expect(session.eventAt(SessionSeq(0))).toBe(session.snapshotEvents()[0])
    expect(session.eventAt(SessionSeq(1))).toBe(session.snapshotEvents()[1])
    expect(session.eventAt(SessionSeq(0))?.data).toEqual({ turn: 1 })
    expect(session.eventAt(SessionSeq(1))?.data).toEqual({ turn: 2 })
  })

  it('returns undefined past the log end and sees appends immediately', () => {
    const session = Session.create(SessionId('event-at-end'))
    expect(session.eventAt(SessionSeq(0))).toBeUndefined()

    session.append('turn/start', { turn: 1 })
    expect(session.eventAt(SessionSeq(0))).toBeDefined()
    expect(session.eventAt(SessionSeq(1))).toBeUndefined()
  })
})
