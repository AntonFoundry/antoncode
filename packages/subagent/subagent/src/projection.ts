/**
 * Pure session projections for subagent identity (mode/label) and active-turn
 * duration.
 *
 * @module @deepseek-ai/dsh-subagent/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from './descriptor.ts'
import type { SubagentDescriptorData } from './descriptor.ts'
import { epochStopReason } from './stop-reason.ts'
import type {
  SubagentIdentityProjection, SubagentOutcomeProjection, SubagentTimingProjection,
} from './projection-types.ts'

interface TimingState {
  /** Milliseconds accumulated across completed post-descriptor turns. */
  settledMs: number
  /** Current open interval kept paired inside the fold. */
  active?: { since: number; through: number }
  /** Latest pre-descriptor turn start, promoted when the child's own descriptor arrives. */
  pendingTurnStart?: number
  /** Whether the fold has crossed a descriptor in this logical log. */
  descriptorSeen: boolean
}

// Zod's optional output includes explicit `undefined`; with
// exactOptionalPropertyTypes the public interface permits omission only.
const projectionSchema = z.object({
  settledMs: z.number().int().nonnegative(),
  active: z.object({
    since: z.number().int().nonnegative(),
    through: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict() as unknown as z.ZodType<SubagentTimingProjection>

/**
 * Fold turn boundaries around the child's own durable descriptor.
 *
 * A fork seed may contain an ancestor descriptor and completed turns. Every
 * descriptor therefore resets the accumulated state; the healthy catalog
 * admits only a child with exactly one descriptor in its own suffix, making
 * the final reset the child's authoritative timing origin.
 */
export const subagentTimingProjectionDefinition:
ProjectionDefinition<'subagentTiming', TimingState> = {
  key: 'subagentTiming',
  schema: projectionSchema,
  init: () => ({ descriptorSeen: false, settledMs: 0 }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      return state.descriptorSeen
        ? { ...state, active: { since: event.time, through: event.time } }
        : { ...state, pendingTurnStart: event.time }
    }
    if (event.type === 'subagent/descriptor') {
      const activeSince = state.active?.since ?? state.pendingTurnStart
      return {
        descriptorSeen: true,
        settledMs: 0,
        ...(activeSince === undefined
          ? {}
          : { active: { since: activeSince, through: event.time } }),
      }
    }
    if (event.type === 'turn/end') {
      if (!state.descriptorSeen) {
        if (state.pendingTurnStart === undefined) return state
        const { pendingTurnStart: _closed, ...next } = state
        return next
      }
      if (state.active === undefined) return state
      const { active, ...rest } = state
      return {
        ...rest,
        settledMs: state.settledMs + Math.max(0, event.time - active.since),
      }
    }
    if (state.active === undefined) return state
    return { ...state, active: { ...state.active, through: event.time } }
  },
  view: state => ({
    settledMs: state.settledMs,
    ...(state.active === undefined ? {} : { active: state.active }),
  }),
  stateVersion: 2,
}

interface IdentityState {
  /** Identity from the last valid descriptor; absent before one, and after an invalid one. */
  identity?: SubagentIdentityProjection
}

// The cast bridges only the optional-label arm: Zod's optional output
// includes explicit `undefined`, which exactOptionalPropertyTypes excludes
// from the public interface. The no-value state itself is the serializable
// `null` arm — never `undefined` — so every registry read and push frame
// survives JSON.stringify losslessly.
const identitySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('one-shot'),
    label: z.string().optional(),
    seq: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    mode: z.literal('continuable'),
    label: z.string(),
    seq: z.number().int().nonnegative(),
  }).strict(),
]).nullable() as unknown as z.ZodType<SubagentIdentityProjection | null>

/** Interpret one `subagent/descriptor` event's identity; no value when the payload cannot be trusted. */
function descriptorIdentity(event: SessionEvent): SubagentIdentityProjection | undefined {
  let descriptor: SubagentDescriptorData | undefined
  try {
    descriptor = foldSubagentDescriptor([event])
  } catch {
    // Only a malformed current-version payload throws in descriptor parsing;
    // a projection fold must never throw, so damage folds to no value.
    descriptor = undefined
  }
  if (descriptor === undefined) return undefined
  return descriptor.mode === 'one-shot'
    ? {
      mode: 'one-shot',
      ...descriptor.label !== undefined ? { label: descriptor.label } : {},
      seq: event.seq,
    }
    : { mode: 'continuable', label: descriptor.label, seq: event.seq }
}

/**
 * Fold the durable mode/label identity from `subagent/descriptor` events,
 * last-wins: a fork seed may replay an ancestor's descriptor, and the child's
 * own descriptor must override it — the same reset discipline as
 * {@link subagentTimingProjectionDefinition}. A malformed or unknown-version
 * payload resets to the `null` sentinel instead of throwing, so a fork of a
 * healthy ancestor never inherits an identity its own descriptor failed to
 * establish — and the reset survives every JSON push frame, so a consumer
 * holding the earlier identity replaces it instead of keeping it stale;
 * `null` ⟺ no valid descriptor, with the causes deliberately undistinguished.
 */
export const subagentIdentityProjectionDefinition:
ProjectionDefinition<'subagent', IdentityState> = {
  key: 'subagent',
  schema: identitySchema,
  init: () => ({}),
  apply: (state, event) => {
    if (event.type !== 'subagent/descriptor') return state
    const identity = descriptorIdentity(event)
    return identity === undefined ? {} : { identity }
  },
  view: state => state.identity ?? null,
  // Bumped when the identity gained its `seq` field: an older checkpoint row
  // would replay into a value the schema rejects, so it must refold instead.
  stateVersion: 2,
}

interface OutcomeState {
  /** The turn whose steps are being observed; absent between turns. */
  openTurn?: number
  /** Whether the open turn entered a model step. */
  openStepped?: boolean
  /** Outcome from the last accounting `turn/end`; absent before one. */
  outcome?: SubagentOutcomeProjection
}

const outcomeSchema = z.object({
  stopReason: z.string(),
  error: z.string().optional(),
  seq: z.number().int().nonnegative(),
}).strict().nullable() as unknown as z.ZodType<SubagentOutcomeProjection | null>

/**
 * Fold the durable terminal outcome from the child's own turn events.
 *
 * The projection answers a different question than the live `subagent/end`
 * event: that edge is dispatched once, to whoever is listening, and is gone. A
 * master agent inspecting a catalog later needs the reason to still be there,
 * and a human needs the dropdown to know a crashed child is not merely idle.
 * Folding it into the session log makes it readable from persistence without
 * resuming the child at all.
 *
 * It folds the TURN STRUCTURE rather than a single ending, because
 * `foldConsumedWork` — the one authority on which `turn/end` accounts for work
 * — needs the turn's steps to answer. Reading an ending in isolation cannot
 * distinguish a turn that computed something from a balanced no-op, so it
 * would either credit cut-short work as finished or invent failures.
 *
 * Each new epoch's outcome replaces the previous one: a child resumed after a
 * failure reports its latest result, which is what a reader deciding whether to
 * resume it again needs.
 */
export const subagentOutcomeProjectionDefinition:
ProjectionDefinition<'subagentOutcome', OutcomeState> = {
  key: 'subagentOutcome',
  schema: outcomeSchema,
  init: () => ({}),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      return { ...state, openTurn: event.data.turn, openStepped: false }
    }
    if (event.type === 'step/start') {
      if (state.openTurn !== event.data.turn) return state
      return { ...state, openStepped: true }
    }
    if (event.type !== 'turn/end') return state
    const { turn, reason } = event.data
    // The accounting turn is the one that stepped; a turn that never reached a
    // model step accounts for no work and must not overwrite a real outcome.
    const accounting = state.openTurn === turn && state.openStepped === true
    const next: OutcomeState = state.openTurn === turn
      ? { ...(state.outcome === undefined ? {} : { outcome: state.outcome }) }
      : state
    if (!accounting) return next
    const stopReason = epochStopReason([
      { type: 'turn/start', seq: event.seq, time: event.time, data: { turn } },
      { type: 'step/start', seq: event.seq, time: event.time, data: { turn, step: 1 } },
      event,
    ] as SessionEvent[])
    const error = reason.kind === 'error' && typeof reason.error?.message === 'string'
      && reason.error.message.length > 0
      ? reason.error.message
      : undefined
    return {
      ...next,
      outcome: { stopReason, ...(error === undefined ? {} : { error }), seq: event.seq },
    }
  },
  view: state => state.outcome ?? null,
  stateVersion: 1,
}
