/** Pure run forest derivation over published Session and Workspace Controller snapshots. */
import type {} from '@deepseek-ai/dsh-tool-todo/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary, SessionListState, SessionProjectionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { type PlanNode, type Run, type RunState, dedupeErrors, flattenPlan } from './contract.ts'

/** Controller snapshots consumed by the board; no backend-specific board RPC. */
export interface BoardSnapshot {
  /** Workspace rows in the registry's durable display order. */
  items: WorkspaceView[]
  /** Archive set: these session ids never render. */
  archivedSessionIds: SessionId[]
  /** Visible session summaries (attached live + cold merged). */
  sessions: SessionSummary[]
  /** Already-published full projections; absent when no projection source is supplied. */
  projectionsBySession?: SessionListState['projectionsBySession']
}

/** Recency fallback window: a non-running session updated within 24h reads queued, else done. */
const QUEUED_MS = 24 * 60 * 60 * 1000

/**
 * State of one session: the live `running` flag wins; recency only classifies
 * a non-running session as queued (recently touched) versus done.
 * @param summary - Board summary row.
 * @param now - Comparison instant for the recency fallback.
 * @returns The board state machine value for the session.
 */
export function stateOf(summary: SessionSummary, now: number): RunState {
  if (summary.running) return 'running'
  // Recency fallback for the queued/done split of non-running sessions; the
  // wire's `running` flag is authoritative for actual activity.
  return now - summary.updatedAt <= QUEUED_MS ? 'queued' : 'done'
}

/**
 * Read the todo tree from a full Controller projection, not the summary payload.
 * @param projection - Published projection; absent before it has been read or followed.
 * @returns The tree, or undefined before a todo write or projection load.
 */
export function readTodos(projection?: SessionProjectionSnapshot): readonly PlanNode[] | undefined {
  return projection?.values.todos ?? undefined
}

/**
 * Builds one run row; the board wire carries no token/cost/timing projections yet.
 * @param summary - Session summary the run is derived from.
 * @param state - Board state machine value.
 * @param children - Already-built child runs.
 * @param titles - Human-facing labels keyed by Session id.
 * @param projection - Published full projection; absent until read or followed.
 * @returns The run row for the session.
 */
function toRun(
  summary: SessionSummary,
  state: RunState,
  children: Run[],
  titles: ReadonlyMap<string, string>,
  projection: SessionProjectionSnapshot | undefined,
): Run {
  const todos = readTodos(projection)
  return {
    id: summary.id,
    parentId: summary.parentId,
    role: 'custom',
    title: titles.get(summary.id) ?? summary.id,
    plan: todos === undefined ? undefined : flattenPlan(todos),
    state,
    tier: 'reasoning',
    mode: 'interactive',
    tokens: { in: 0, out: 0 },
    costUsd: 0,
    wallMs: 0,
    errors: dedupeErrors([]),
    children,
  }
}

/**
 * Derives the run forest from one board snapshot.
 *
 * Placement: each workspace's non-subagent sessions become roots (in the
 * workspace's owned order); sessions with `origin: 'subagent'` and a
 * `parentSessionId` attach under that parent. Active-only filtering (default)
 * drops done families entirely — a done root hides its whole subtree, and a
 * done orphan subagent hides alone; an active root keeps its done children
 * visible.
 * @param board - Published workspace rows, summaries, and available full projections.
 * @param opts - `now` overrides the comparison instant; `activeOnly` (default
 *   true) filters done families; `titles` overlays display titles (the
 *   runtime sessions service's human-facing label) onto card rows.
 * @returns Root runs in workspace order, orphans (active subagents with no
 *   placed parent) appended last.
 */
export function deriveRuns(
  board: BoardSnapshot,
  opts: { now?: number; activeOnly?: boolean; titles?: ReadonlyMap<string, string> } = {},
): Run[] {
  const now = opts.now ?? Date.now()
  const activeOnly = opts.activeOnly ?? true
  const titles = opts.titles ?? new Map<string, string>()
  const keep = (s: SessionSummary) => !activeOnly || stateOf(s, now) !== 'done'
  const archived = new Set<string>(board.archivedSessionIds)
  const byId = new Map<string, SessionSummary>(
    board.sessions.filter(s => !archived.has(s.id)).map(s => [s.id, s]),
  )
  const runs: Run[] = []
  const placed = new Set<string>()
  const kidsOf = (id: string) =>
    [...byId.values()].filter(c => c.origin === 'subagent' && c.parentId === id)
  for (const w of board.items) {
    for (const id of w.sessionIds) {
      const s = byId.get(id)
      if (s === undefined || s.origin === 'subagent' || placed.has(s.id)) continue
      placed.add(s.id)
      if (!keep(s)) continue // family stays hidden with its dead root
      const children = kidsOf(s.id)
        .map((c) => { placed.add(c.id); return c })
        .filter(keep)
        .map(c => toRun(c, stateOf(c, now), [], titles, board.projectionsBySession?.[c.id]))
      runs.push(toRun(s, stateOf(s, now), children, titles, board.projectionsBySession?.[s.id]))
    }
  }
  // Active subagent orphans whose parent is not on the board render at top level.
  for (const s of byId.values()) {
    if (s.origin === 'subagent' && !placed.has(s.id) && keep(s)) {
      runs.push(toRun(s, stateOf(s, now), [], titles, board.projectionsBySession?.[s.id]))
    }
  }
  return runs
}
