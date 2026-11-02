/**
 * Pure types of the todo domain: the ONE home of the `todos` projection-key
 * declaration plus its payload types, free of this package's host-side value
 * imports (dsh-tools, zod). Two namespace projections serve it — `./types`
 * for host consumers, `./client/types` (the browser half-entry's re-export)
 * for client aggregates — with zero content duplication.
 *
 * @module @deepseek-ai/dsh-tool-todo/types
 */

import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

/**
 * One node in an agent's todo tree — the unit of the `todo/write`
 * whole-tree snapshot declared by this package.
 *
 * A node carries a human-readable `content` line, a four-state `status`, an
 * optional `priority`, and optional nested `children` — up to three levels
 * (top-level task, child, grandchild), enforced at the tool-JSON boundary and
 * by the owning package invariant, not by this type. The tree is replaced
 * wholesale on every write (last-write-wins), so nodes need no stable identity.
 */
export interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /**
   * Lifecycle state. `in_progress` marks a task being worked now; parallel
   * work may mark several. `cancelled` retires a node no longer needed without
   * counting it unfinished.
   */
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  /** Scheduling weight the model assigns; presentation-only. */
  priority?: 'high' | 'medium' | 'low'
  /** Nested subtasks, at most two levels below a top-level node (three levels total). */
  children?: TodoItem[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole-tree snapshot; latest write wins on replay. Log-only UI state; never derived history. */
    'todo/write': { todos: TodoItem[] }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The agent's current whole todo tree (the latest `todo/write` snapshot),
     * or `null` before the first write. Whole-value rule: every `todo/write`
     * carries the complete replacement tree (up to three levels), so the fold
     * is last-wins. Excluded from Session summary payloads, with `null` kept
     * outside the exclusion mark so the pre-first-write value stays expressible.
     */
    todos: SessionProjectionSummaryExcluded<TodoItem[]> | null
  }
}
