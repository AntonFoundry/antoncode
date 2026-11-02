/**
 * Pure types of the plan domain: the ONE home of the `plan` projection-key
 * declaration, free of this package's host-side value imports (cordis,
 * dsh-tools, dsh-agent). Two namespace projections serve it — `./types` for
 * host consumers and `./client` for client aggregates — with zero content
 * duplication.
 *
 * @module @deepseek-ai/dsh-plan-mode/types
 */

import type { CommandId } from '@deepseek-ai/dsh-commands/brand'

/**
 * The plan projection's wire value. `active` is the logged state in force
 * (the last `plan/mode`, inactive before the first); `pending` is true while
 * a logged `/plan` selection targets a state other than `active`, has not
 * failed through its paired `command/done`, and no later `plan/mode` event has
 * recorded that state. Capability absence (plan-mode not composed) is the
 * key's absence, never a value.
 */
export interface PlanProjection {
  active: boolean
  pending: boolean
  standingPlan?: {
    plan: string
    title?: string | undefined
    path?: string | undefined
  } | null | undefined
}

/**
 * The standing implementation plan recorded by `plan_write`: log-only and
 * whole-value replace, so the last write is the plan in force.
 */
export interface StandingPlan {
  /** Complete markdown plan, starting with a `#` heading. */
  plan: string
  /** Headline taken from the plan's first heading when it has one. */
  title?: string | undefined
  /** Workspace-relative path the markdown was written to. */
  path?: string | undefined
}

/** Host state used to derive {@link PlanProjection}. */
export interface PlanUnitState {
  /** Logged plan mode. */
  active: boolean
  /** The selection's target mode; null when no selection is outstanding. */
  wanted: boolean | null
  /** The latest plan command awaiting its paired settlement. */
  running: { commandId: CommandId; wanted: boolean } | null
  /** Active state recorded by the latest `request/header`, or null. */
  activeAtLastHeader: boolean | null
  /** Whether a logged `plan/mode` has ever activated plan mode in this Session. */
  entered: boolean
  /** The standing implementation plan in force, or null before the first `plan/write`. */
  standingPlan: StandingPlan | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Plan collaboration state folded from the plan command lifecycle and `plan/mode` events. */
    plan: PlanProjection
  }
}
