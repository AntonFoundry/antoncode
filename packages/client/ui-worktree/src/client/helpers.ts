/**
 * Pure worktree-name and repository-resolution helpers shared by the composer
 * context bar and the session header's repo-status chip.
 *
 * @module dsh-client-ui-worktree/helpers
 */

import type { WorktreeModePrefView, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'

/** The worktree directory basename — the name the sidebar prefixes sessions with. */
export function worktreeName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

/**
 * The governing repository entry for a cwd: the exact key, or the longest
 * recorded key containing the path as a child (`repo/…`) or in the worktree
 * sibling layout (`repo.…`). Mirrors the runtime's resolution so the control
 * and the New Session flow agree.
 */
export function resolveRepo(
  path: string,
  prefs: WorkspaceListState['worktrees']['prefs'],
): { key: string; pref: WorktreeModePrefView } | undefined {
  const direct = Object.entries(prefs).find(([repo]) => repo === path)
  if (direct !== undefined) return { key: direct[0], pref: direct[1] }
  let best: { key: string; pref: WorktreeModePrefView } | undefined
  for (const [repo, pref] of Object.entries(prefs)) {
    const contained = path.startsWith(`${repo}/`) || path.startsWith(`${repo}.`)
    if (contained && (best === undefined || repo.length > best.key.length)) best = { key: repo, pref }
  }
  return best
}
