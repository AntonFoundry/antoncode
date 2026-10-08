/**
 * Public type vocabulary of the worktree entity: the `WorktreeId` brand and
 * the live status projection. The durable record and mode-preference unions
 * are inferred from the domain schemas in `spec.ts`. Types only — runtime
 * code stays out of this file.
 * @module @deepseek-ai/dsh-worktree/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Identifies one worktree record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
export type WorktreeId = Branded<'WorktreeId'>

/** Live git state of one repository working directory, projected for display. */
export interface WorktreeStatus {
  /** Queried directory (canonical). */
  readonly path: string
  /** Checked-out branch, or a detached marker when HEAD is not on a branch. */
  readonly branch: string
  /** Short head commit. */
  readonly head: string
  /** Whether the working tree has tracked or untracked changes. */
  readonly dirty: boolean
  /** Number of stashes in the repository (stashes are repo-global across worktrees). */
  readonly stashCount: number
  /** Commits ahead of the upstream, 0 when no upstream is configured. */
  readonly ahead: number
  /** Commits behind the upstream, 0 when no upstream is configured. */
  readonly behind: number
  /** Candidate base refs for a new worktree branch (remote-tracking short names, then `HEAD`). */
  readonly bases: readonly string[]
}
