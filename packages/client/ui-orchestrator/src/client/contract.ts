/**
 * Run contract for the Orchestrator board and Dag Flow: state vocabulary,
 * colors, triage sets, and the pure folds over raw error events. No DOM,
 * no transport.
 */

/** Coarse role label for a run card; the wire carries no richer taxonomy yet. */
export type Role = 'planner' | 'coder' | 'reviewer' | 'test-runner' | 'custom'

/** Board state machine per run. */
export type RunState = 'queued' | 'running' | 'blocked' | 'verifying' | 'done' | 'failed' | 'stalemate'

/** Model class backing a run. */
export type ModelTier = 'reasoning' | 'code' | 'deterministic'

/** Human-in-the-loop mode. */
export type MissionMode = 'interactive' | 'autopilot'

/** Engine health vocabulary mirrored into the health strip pills. */
export type Health = 'up' | 'degraded' | 'down'

/** One deduped error chip, keyed by signature. */
export interface DedupedError {
  /** Stable collapse key (first line of the failure text). */
  sig: string
  /** Occurrences folded into this chip. */
  count: number
  /** Earliest occurrence (any comparable time value). */
  firstSeen: string | number
  /** Latest occurrence. */
  lastSeen: string | number
}

/** One flattened plan row on a mission card, derived from the session's todo tree. */
export interface PlanRow {
  /** What this task is — a short imperative line. */
  content: string
  /** Todo lifecycle state, carried through from the `todo/write` snapshot. */
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

/** One board run: a root session or one nested subagent child. */
export interface Run {
  /** Session id the run was derived from. */
  id: string
  /** Parent session id when the run is a subagent child. */
  parentId?: string | undefined
  role: Role
  /** Display title; the board wire has no title projection yet, so the session id. */
  title: string
  state: RunState
  tier: ModelTier
  mode: MissionMode
  /** Token accounting; not on the board wire yet, always zero. */
  tokens: { in: number; out: number }
  /** Cost accounting; not on the board wire yet, always zero. */
  costUsd: number
  /** Wall-clock time; not on the board wire yet, always zero. */
  wallMs: number
  /** Deduped error chips for the run. */
  errors: DedupedError[]
  /** Flattened mission plan from the session's `todos` projection; absent before the first `todo/write`. */
  plan?: readonly PlanRow[] | undefined
  /** Nested subagent runs. */
  children: Run[]
}

/** Card action the board can request on a run. Only `kill` is server-side today. */
export type RunAction = 'approve' | 'retry' | 'kill' | 'inject note' | 'focus'

/** Fill color per run state. */
export const STATE_COLOR: Record<RunState, string> = {
  queued: '#6b7280',
  running: '#3b82f6',
  blocked: '#f59e0b',
  verifying: '#eab308',
  done: '#10b981',
  failed: '#ef4444',
  stalemate: '#a855f7',
}

/** Fill color per engine health. */
export const HEALTH_COLOR: Record<Health, string> = {
  up: '#10b981',
  degraded: '#f59e0b',
  down: '#ef4444',
}

/** States that surface in the NEEDS YOU triage column. */
export const NEEDS_YOU: readonly RunState[] = ['blocked', 'failed', 'verifying', 'stalemate']

/**
 * Collapses raw error events into deduped chips keyed by signature.
 * @param events - `{sig, ts}` rows in any order.
 * @returns One chip per distinct signature, with count and first/last seen.
 */
export function dedupeErrors(events: ReadonlyArray<{ sig: string; ts: string | number }>): DedupedError[] {
  const bySig = new Map<string, DedupedError>()
  for (const e of events) {
    const prev = bySig.get(e.sig)
    if (!prev) bySig.set(e.sig, { sig: e.sig, count: 1, firstSeen: e.ts, lastSeen: e.ts })
    else {
      prev.count++
      if (e.ts > prev.lastSeen) prev.lastSeen = e.ts
      if (e.ts < prev.firstSeen) prev.firstSeen = e.ts
    }
  }
  return [...bySig.values()]
}

/**
 * Flattens a todo tree (up to three levels) into ordered plan rows,
 * depth-first. Nested subtasks follow their parent.
 * @param todos - The `todo/write` snapshot's nested tree.
 * @returns Depth-first rows in parent-before-child order.
 */
/** Structural view of one `todo/write` tree node (subset the flatten reads). */
export interface PlanNode {
  /** What this task is — a short imperative line. */
  content: string
  /** Todo lifecycle state. */
  status: PlanRow['status']
  /** Nested subtasks, at most two levels below a top-level node. */
  children?: readonly PlanNode[]
}

/**
 * Flattens a todo tree (up to three levels) into ordered plan rows,
 * depth-first. Nested subtasks follow their parent.
 * @param todos - The `todo/write` snapshot's nested tree.
 * @returns Depth-first rows in parent-before-child order.
 */
export function flattenPlan(todos: readonly PlanNode[]): PlanRow[] {
  const rows: PlanRow[] = []
  const walk = (nodes: readonly PlanNode[]): void => {
    for (const node of nodes) {
      rows.push({ content: node.content, status: node.status })
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(todos)
  return rows
}

/**
 * Depth-first flatten of a run tree, root first.
 * @param run - Tree root.
 * @returns The root and every descendant in depth-first order.
 */
export function flattenRuns(run: Run): Run[] {
  return [run, ...run.children.flatMap(flattenRuns)]
}

/**
 * Runs that need a human decision right now.
 * @param runs - Runs to filter (any order).
 * @returns The subset whose state is in `NEEDS_YOU`.
 */
export const needsYou = (runs: readonly Run[]): Run[] => runs.filter(r => NEEDS_YOU.includes(r.state))

/**
 * Runs currently consuming an agent.
 * @param runs - Runs to filter (any order).
 * @returns The subset in `running` or `queued` state.
 */
export const runningRuns = (runs: readonly Run[]): Run[] =>
  runs.filter(r => r.state === 'running' || r.state === 'queued')

/**
 * Finished runs.
 * @param runs - Runs to filter (any order).
 * @returns The subset in `done` state.
 */
export const done = (runs: readonly Run[]): Run[] => runs.filter(r => r.state === 'done')

/**
 * Stalemate detector: reviewer/coder ping-pong with no diff delta for N rounds.
 * @param rounds - Per-round records carrying a `diffDelta` number.
 * @param limit - Consecutive flat rounds that constitute a stalemate.
 * @returns True when the last `limit` rounds are all flat.
 */
export function detectStalemate(rounds: ReadonlyArray<{ diffDelta: number }>, limit = 3): boolean {
  return rounds.length >= limit && rounds.slice(-limit).every(r => r.diffDelta === 0)
}
