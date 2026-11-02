/**
 * Injected faces of the two worktree surface entries. The target slots are
 * declared and typed by ui-conversation; this package only contributes
 * entries, so no SlotMap merge lives here. Live state (worktree projection,
 * session summaries) arrives through the framework standard kit
 * (`useSessions` / `useWorkspaces`); inject carries only the write verbs and
 * the status query.
 */

import type { WorktreeModePrefView, WorktreeStatus } from '@deepseek-ai/dsh-api-workspace-controller/worktree-types'

/** Injected business face of the composer context bar. */
export interface WorktreeBarActions {
  /**
   * Write the per-repository default workspace mode (and base ref) for new sessions.
   * @param repoPath - the repository key the preference is stored under.
   * @param pref - checkout, fresh-worktree-per-session, or a named worktree.
   */
  setMode: (repoPath: string, pref: WorktreeModePrefView) => Promise<void>
  /** Reload the worktree projection from the Host (fire-and-forget refresh). */
  refresh: () => void
  /**
   * Live git status of one working directory (branch, stash count, base candidates).
   * @param path - working directory to query.
   * @param signal - aborts the query when the caller supersedes it.
   * @returns the status bundle.
   */
  status: (path: string, signal?: AbortSignal) => Promise<WorktreeStatus>
}

/** Injected business face of the session header's repo-status chip. */
export interface RepoStatusActions {
  /**
   * Live git status of one working directory.
   * @param path - working directory to query.
   * @param signal - aborts the query when the caller supersedes it.
   * @returns the status bundle.
   */
  status: (path: string, signal?: AbortSignal) => Promise<WorktreeStatus>
}
