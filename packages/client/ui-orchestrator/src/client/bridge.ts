/**
 * Derives the board's `Run[]` from one `orchestrator.board` snapshot.
 * Pure over the wire projection: `running` is the attached agent's live flag
 * (never a heuristic), parent/child links follow `parentSessionId`, and
 * archived sessions never render. No DOM, no transport.
 */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api/sessions.ts'
import type { WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy/api/workspace.ts'
import { type PlanNode, type PlanRow, type Run, type RunState, dedupeErrors, flattenPlan } from './contract.ts'

/** Everything the board renders, exactly the `orchestrator.board` response value. */
export interface BoardSnapshot {
  /** Workspace rows in the registry's durable display order. */
  items: WorkspaceView[]
  /** Archive set: these session ids never render. */
  archivedSessionIds: SessionId[]
  /** Visible session summaries (attached live + cold merged). */
  sessions: SessionSummary[]
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
 * Extracts the mission plan tree from one board summary's projections block,
 * keeping its nesting. The `todos` projection key is merged into
 * `SessionProjectionMap` by the todo tool; a summary without projections (or
 * before any write) plans nothing.
 * @param summary - Board summary carrying the session's projection block.
 * @returns The nested tree, or undefined when the session has no tree.
 */
export function readTodos(summary: SessionSummary): readonly PlanNode[] | undefined {
  const todos = (summary.projections?.values as Partial<{ todos: unknown }> | undefined)?.todos
  if (!Array.isArray(todos)) return undefined
  return todos as readonly PlanNode[]
}

/**
 * Flattens one board summary's plan tree into ordered plan rows for the board
 * cards. The Dag Flow graph reads {@link readTodos} instead, because task cards
 * need the nesting a flatten discards.
 * @param summary - Board summary carrying the session's projection block.
 * @returns Flattened plan rows, or undefined when the session has no tree.
 */
function flattenTodos(summary: SessionSummary): readonly PlanRow[] | undefined {
  const todos = readTodos(summary)
  return todos === undefined ? undefined : flattenPlan(todos)
}

/**
 * Builds one run row; the board wire carries no token/cost/timing projections yet.
 * @param summary - Session summary the run is derived from.
 * @param state - Board state machine value.
 * @param children - Already-built child runs.
 * @returns The run row for the session.
 */
function toRun(
  summary: SessionSummary,
  state: RunState,
  children: Run[],
  titles: ReadonlyMap<string, string> = new Map(),
): Run {
  return {
    id: summary.sessionId,
    parentId: summary.parentSessionId,
    role: 'custom',
    title: titles.get(summary.sessionId) ?? summary.sessionId,
    // The session's mission plan rides the wire's `todos` projection (the
    // latest todo/write snapshot); absent before the first write.
    plan: flattenTodos(summary),
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
 * @param board - One `orchestrator.board` snapshot.
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
    board.sessions.filter(s => !archived.has(s.sessionId)).map(s => [s.sessionId, s]),
  )
  const runs: Run[] = []
  const placed = new Set<string>()
  const kidsOf = (id: string) =>
    [...byId.values()].filter(c => c.origin === 'subagent' && c.parentSessionId === id)
  for (const w of board.items) {
    for (const id of w.sessionIds) {
      const s = byId.get(id)
      if (s === undefined || s.origin === 'subagent' || placed.has(s.sessionId)) continue
      placed.add(s.sessionId)
      if (!keep(s)) continue // family stays hidden with its dead root
      const children = kidsOf(s.sessionId)
        .map((c) => { placed.add(c.sessionId); return c })
        .filter(keep)
        .map(c => toRun(c, stateOf(c, now), [], titles))
      runs.push(toRun(s, stateOf(s, now), children, titles))
    }
  }
  // Active subagent orphans whose parent is not on the board render at top level.
  for (const s of byId.values()) {
    if (s.origin === 'subagent' && !placed.has(s.sessionId) && keep(s)) {
      runs.push(toRun(s, stateOf(s, now), [], titles))
    }
  }
  return runs
}
