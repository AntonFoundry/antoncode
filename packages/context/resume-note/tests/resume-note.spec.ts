import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import * as resumeNote from '@deepseek-ai/dsh-resume-note'
import type { Config } from '@deepseek-ai/dsh-resume-note'

const SIGNAL = new AbortController().signal

async function mount(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const fiber = await ctx.plugin(resumeNote, config)
  return { ctx, fiber }
}

function sessionAgent(session: Session, id = 'agent'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('resume-note must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function openTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${String(turn)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function closeTurn(session: Session, turn: number, kind: 'interrupted' | 'complete'): void {
  session.append('turn/end', { turn, reason: kind === 'interrupted' ? { kind: 'interrupted' } : { kind: 'completed' } })
}

async function fire(ctx: Context, agent: Agent, turn: number, step: number): Promise<void> {
  const proposed = createUserMessage({
    content: [{ type: 'text', text: 'request proposal' }],
    source: { kind: 'plugin', plugin: 'resume-note-test' },
  })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn, step, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      session(agent).append('user/message', message, { surfaceOp: 'append' })
    }
  }
}

function session(agent: Agent): Session {
  return agent.session
}

function noteTexts(events: readonly SessionEvent[]): string[] {
  const texts: string[] = []
  for (const event of events) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'resume-note') {
      texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return texts
}

describe('resume-note', () => {
  it('appends one note at step 1 when the last turn/end is interrupted', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('interrupted'))
    openTurn(session, 1)
    closeTurn(session, 1, 'interrupted')
    openTurn(session, 2)
    await fire(ctx, sessionAgent(session), 2, 1)
    expect(noteTexts(session.events)).toEqual([resumeNote.DEFAULT_NOTE_TEXT])
  })

  it('does not append after a normally completed turn', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('complete'))
    openTurn(session, 1)
    closeTurn(session, 1, 'complete')
    openTurn(session, 2)
    await fire(ctx, sessionAgent(session), 2, 1)
    expect(noteTexts(session.events)).toEqual([])
  })

  it('does not append twice for the same interruption', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('once'))
    openTurn(session, 1)
    closeTurn(session, 1, 'interrupted')
    openTurn(session, 2)
    await fire(ctx, sessionAgent(session), 2, 1)
    await fire(ctx, sessionAgent(session), 2, 1)
    expect(noteTexts(session.events)).toEqual([resumeNote.DEFAULT_NOTE_TEXT])
  })

  it('appends again after a fresh interruption following a delivered note', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('stacked'))
    openTurn(session, 1)
    closeTurn(session, 1, 'interrupted')
    openTurn(session, 2)
    await fire(ctx, sessionAgent(session), 2, 1)
    closeTurn(session, 2, 'interrupted')
    openTurn(session, 3)
    await fire(ctx, sessionAgent(session), 3, 1)
    expect(noteTexts(session.events)).toEqual([resumeNote.DEFAULT_NOTE_TEXT, resumeNote.DEFAULT_NOTE_TEXT])
  })

  it('does not append at steps after the first', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('step2'))
    openTurn(session, 1)
    closeTurn(session, 1, 'interrupted')
    openTurn(session, 2)
    await fire(ctx, sessionAgent(session), 2, 2)
    expect(noteTexts(session.events)).toEqual([])
  })

  it('does not append when the log has no turn/end', async () => {
    const { ctx } = await mount()
    const session = Session.create(SessionId('fresh'))
    openTurn(session, 1)
    await fire(ctx, sessionAgent(session), 1, 1)
    expect(noteTexts(session.events)).toEqual([])
  })

  it('honors a text override and the enabled=false switch', async () => {
    const custom = await mount({ text: 'custom note' })
    const session = Session.create(SessionId('custom'))
    openTurn(session, 1)
    closeTurn(session, 1, 'interrupted')
    openTurn(session, 2)
    await fire(custom.ctx, sessionAgent(session), 2, 1)
    expect(noteTexts(session.events)).toEqual(['custom note'])

    const off = await mount({ enabled: false })
    const quiet = Session.create(SessionId('off'))
    openTurn(quiet, 1)
    closeTurn(quiet, 1, 'interrupted')
    openTurn(quiet, 2)
    await fire(off.ctx, sessionAgent(quiet), 2, 1)
    expect(noteTexts(quiet.events)).toEqual([])
  })

  it('stops injecting when its fiber is disposed', async () => {
    const { ctx, fiber } = await mount()
    const session = Session.create(SessionId('dispose'))
    openTurn(session, 1)
    closeTurn(session, 1, 'interrupted')
    openTurn(session, 2)
    await fiber.dispose()
    await fire(ctx, sessionAgent(session), 2, 1)
    expect(noteTexts(session.events)).toEqual([])
  })
})
