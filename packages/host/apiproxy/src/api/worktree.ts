/**
 * worktree domain contract. Wire projection of the host-side worktree
 * registry (@deepseek-ai/dsh-worktree): durable git worktree records per
 * repository, live repo status, and the per-repository default workspace
 * mode. Method signatures are the source of truth, same as the sessions and
 * workspace domains.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from './workspace.ts'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * Wire-side worktree id brand. Deliberately re-declared here rather than
 * imported from dsh-worktree: api/ must stay browser-importable with zero
 * host-package dependencies, and the brand string matches, so both sides
 * agree structurally.
 */
export type WorktreeId = Branded<'WorktreeId'>

/** One worktree row: the record projection every worktree.* value carries. */
export interface WorktreeView {
  worktreeId: WorktreeId
  /** Canonical path of the repository the worktree belongs to. */
  repoPath: string
  /** Canonical path of the worktree directory. */
  path: string
  /** Git branch checked out in the worktree. */
  branch: string
  /** Ref the worktree branched from at create time. */
  base: string
  /** Workspace registered over `path` at create, when registration succeeded. */
  workspaceId?: WorkspaceId
  /**
   * Display name claimed from the first titled session inside the worktree,
   * when one has titled it; absent means consumers derive the name from
   * `path`'s basename.
   */
  alias?: string
  /** ISO-8601 creation instant. */
  createdAt: string
}

/** Live git state of one working directory (`worktree.status`). */
export interface WorktreeStatusView {
  /** Queried directory (canonical). */
  path: string
  /** Checked-out branch, or a detached marker when HEAD is not on a branch. */
  branch: string
  /** Short head commit. */
  head: string
  /** Whether the working tree has tracked or untracked changes. */
  dirty: boolean
  /** Number of stashes in the repository (repo-global across worktrees). */
  stashCount: number
  /** Commits ahead of the upstream, 0 when no upstream is configured. */
  ahead: number
  /** Commits behind the upstream, 0 when no upstream is configured. */
  behind: number
  /** Candidate base refs for a new worktree branch (remote-tracking short names, then `HEAD`). */
  readonly bases: readonly string[]
}

/**
 * The per-repository default workspace mode for new sessions (`checkout` = the
 * repository checkout, `new` = a fresh worktree per session, `reuse` = the
 * named existing worktree). `worktree.pref` reports `null` when a repository
 * has no stored preference.
 */
export type WorktreeModePrefView =
  | { mode: 'checkout'; base?: string | undefined }
  | { mode: 'new'; base?: string | undefined }
  | { mode: 'reuse'; worktreeId: WorktreeId; base?: string | undefined }

/** Worktree-domain unary methods (the map keys worktree.* of RpcMethodMap). */
export interface WorktreeApi {
  /**
   * Lists durable worktree records, newest first, plus the full
   * per-repository default-mode preference map (one read for clients
   * projecting every workspace's mode).
   * @param request.payload.repoPath - When given, only worktrees of the
   *   repository owning that directory (any checkout or worktree of it) are
   *   returned; `prefs` is unaffected and always complete.
   */
  list(request: RpcRequest<{ repoPath?: string }>):
  Promise<RpcResponse<{ items: WorktreeView[]; prefs: Record<string, WorktreeModePrefView> }>>

  /**
   * Materializes a git worktree for a repository and registers it durably.
   * The branch is `agent/<slug>` (deployment `branchPrefix`); an existing
   * branch is checked out as-is (reattachment). The worktree directory is
   * also registered as a workspace (title = branch); workspace-registration
   * failure degrades to an ungrouped worktree and never fails the create.
   * A directory outside any git repository fails with
   * `worktree-not-a-repository`; a failing git command fails with
   * `worktree-git-error` carrying git's own diagnostic.
   */
  create(request: RpcRequest<{ repoPath: string; name?: string; base?: string }>):
  Promise<RpcResponse<{ worktree: WorktreeView }>>

  /**
   * Live git projection of one working directory: branch, head, dirty flag,
   * repo-global stash count, and upstream divergence. A directory outside
   * any git repository fails with `worktree-not-a-repository`.
   */
  status(request: RpcRequest<{ path: string }>): Promise<RpcResponse<WorktreeStatusView>>

  /**
   * Reads the per-repository default workspace mode. `pref` is `null` when
   * the repository has no stored preference.
   */
  pref(request: RpcRequest<{ repoPath: string }>):
  Promise<RpcResponse<{ pref: WorktreeModePrefView | null }>>

  /**
   * Writes the per-repository default workspace mode. `pref.mode === 'reuse'`
   * names an existing worktree id; the value is stored verbatim (no live
   * worktree check) so a preference survives worktree listing races.
   */
  setPref(request: RpcRequest<{ repoPath: string; pref: WorktreeModePrefView }>):
  Promise<RpcResponse<{ saved: true }>>

  /**
   * Removes one worktree: `git worktree remove` (refuses a dirty tree unless
   * `force`) plus the durable record deletion. The branch is never deleted —
   * merge-back keeps it. An unknown id fails with `worktree-not-found`.
   */
  remove(request: RpcRequest<{ worktreeId: WorktreeId; force?: boolean }>):
  Promise<RpcResponse<{ deleted: true }>>
}
