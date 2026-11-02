import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '../src/index.ts'
import { SUBAGENT_DESCRIPTOR_VERSION } from '../src/descriptor.ts'
import {
  subagentIdentityProjectionDefinition, subagentOutcomeProjectionDefinition, subagentTimingProjectionDefinition,
  type TimingState,
} from '../src/projection.ts'

function event(
  type: SessionEvent['type'],
  seq: number,
  time: number,
  reason: TurnEndReason = { kind: 'completed' },
): SessionEvent {
  return {
    type,
    seq,
    time,
    data: type === 'turn/end' ? { turn: 1, reason } : {},
  } as SessionEvent
}

function fold(events: SessionEvent[]) {
  let state: TimingState = subagentTimingProjectionDefinition.init()
  for (const item of events) state = subagentTimingProjectionDefinition.apply(state, item)
  return subagentTimingProjectionDefinition.wire.view(state)
}

describe('subagent timing projection', () => {
  it('preserves historical one-shot identity without inventing a label', () => {
    const descriptor = {
      ...event('subagent/descriptor', 1, 110),
      data: { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'spawn' },
    } as SessionEvent
    const state = subagentIdentityProjectionDefinition.apply(subagentIdentityProjectionDefinition.init(), descriptor)
    expect(subagentIdentityProjectionDefinition.wire.view(state)).toEqual({ mode: 'one-shot', seq: 1 })
  })

  it('waits for the session projection registry and releases its projections on unload', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await mountWorkingDirectoryFixture(ctx)
    const pending = ctx.plugin(SubagentRuntime)
    expect(ctx.get('subagents')).toBeUndefined()
    await ctx.plugin(SessionProjectionRegistry)
    const serviceFiber = await pending

    const before = ctx.sessionProjections.snapshot(ctx.sessions.create()).values
    expect(before.subagentTiming).toEqual({ settledMs: 0 })
    // The identity unit registers alongside timing; an empty log serves its
    // serializable null sentinel.
    expect(before.subagent).toBeNull()
    await serviceFiber.dispose()
    const after = ctx.sessionProjections.snapshot(ctx.sessions.create()).values
    expect(after.subagentTiming).toBeUndefined()
    expect(after.subagent).toBeUndefined()
    expect(after.subagentOutcome).toBeUndefined()
  })

  it('resets inherited seed timing at the child descriptor and sums later completed turns', () => {
    expect(fold([
      event('turn/start', 0, 100),
      event('subagent/descriptor', 1, 110),
      event('turn/end', 2, 300),
      event('turn/start', 3, 1_000),
      event('subagent/descriptor', 4, 1_100),
      event('turn/end', 5, 4_100),
      event('turn/start', 6, 10_000),
      event('turn/end', 7, 12_000),
    ])).toEqual({ settledMs: 5_100, lastTurnCompleted: true })
  })

  it('exposes an open turn start and never subtracts time for reversed boundaries', () => {
    expect(fold([
      event('turn/start', 0, 1_000),
      event('subagent/descriptor', 1, 1_100),
      event('turn/end', 2, 900),
      event('turn/start', 3, 2_000),
      event('assistant/attempt', 4, 2_500),
    ])).toEqual({ settledMs: 0, active: { since: 2_000, through: 2_500 } })
  })

  it('publishes only the latest closed turn completion and clears it when another turn opens', () => {
    expect(fold([
      event('turn/start', 0, 100),
      event('subagent/descriptor', 1, 110),
      event('turn/end', 2, 200),
      event('turn/start', 3, 300),
      event('turn/end', 4, 400, { kind: 'interrupted' }),
    ])).toEqual({ settledMs: 200, lastTurnCompleted: false })

    expect(fold([
      event('turn/start', 0, 100),
      event('subagent/descriptor', 1, 110),
      event('turn/end', 2, 200),
      event('turn/start', 3, 300),
    ])).toEqual({ settledMs: 100, active: { since: 300, through: 300 } })
  })

  it('ignores completed pre-descriptor turns and unrelated events', () => {
    const initial = subagentTimingProjectionDefinition.init()
    expect(subagentTimingProjectionDefinition.apply(
      initial,
      event('assistant/attempt', 0, 1),
    )).toBe(initial)
    expect(subagentTimingProjectionDefinition.apply(
      initial,
      event('turn/end', 1, 2),
    )).toBe(initial)
    const descriptor = subagentTimingProjectionDefinition.apply(
      initial,
      event('subagent/descriptor', 2, 3),
    )
    expect(subagentTimingProjectionDefinition.apply(
      descriptor,
      event('turn/end', 3, 4),
    )).toBe(descriptor)
    expect(fold([
      event('turn/start', 0, 100),
      event('turn/end', 1, 200),
      event('subagent/descriptor', 2, 300),
    ])).toEqual({ settledMs: 0 })
  })
})

describe('subagent outcome projection', () => {
  /**
   * One accounting turn: `foldConsumedWork` only counts a `turn/end` that
   * closes a turn some `step/start` opened, so a bare ending reports nothing.
   */
  function turn(kind: string, seq: number, message?: string): SessionEvent[] {
    return [
      { type: 'turn/start', seq, time: seq * 10, data: { turn: 1 } } as unknown as SessionEvent,
      { type: 'step/start', seq: seq + 1, time: seq * 10 + 1, data: { turn: 1, step: 1 } } as unknown as SessionEvent,
      {
        type: 'turn/end',
        seq: seq + 2,
        time: seq * 10 + 2,
        data: {
          turn: 1,
          reason: kind === 'error'
            ? { kind, error: { message: message ?? 'boom' } }
            : { kind },
        },
      } as unknown as SessionEvent,
    ]
  }

  function foldOutcome(events: SessionEvent[]) {
    let state = subagentOutcomeProjectionDefinition.init()
    for (const item of events) state = subagentOutcomeProjectionDefinition.apply(state, item)
    return subagentOutcomeProjectionDefinition.wire.view(state)
  }

  it('serves null before any turn closes', () => {
    expect(foldOutcome([])).toBeNull()
    expect(foldOutcome([event('turn/start', 0, 1)])).toBeNull()
  })

  it('records a failure with its reason, so a crashed child is not merely idle', () => {
    expect(foldOutcome(turn('error', 5, 'no adapter registered')))
      .toEqual({ stopReason: 'error', error: 'no adapter registered', seq: 7 })
  })

  it('distinguishes a clean completion from a failure', () => {
    expect(foldOutcome(turn('completed', 3))).toEqual({ stopReason: 'completed', seq: 5 })
    expect(foldOutcome(turn('max-tokens', 3))).toEqual({ stopReason: 'max-tokens', seq: 5 })
    expect(foldOutcome(turn('interrupted', 3))).toEqual({ stopReason: 'aborted', seq: 5 })
    expect(foldOutcome(turn('blocked', 3))).toEqual({ stopReason: 'refusal', seq: 5 })
  })

  it('replaces the outcome of an earlier epoch, so a resumed child reports its latest result', () => {
    expect(foldOutcome([
      ...turn('error', 5, 'first failure'),
      ...turn('completed', 20),
    ])).toEqual({ stopReason: 'completed', seq: 22 })
  })
})
