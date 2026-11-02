/** Browser-safe worktree Remote values. */
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorktreeId } from '@deepseek-ai/dsh-worktree/types'

export type { WorktreeId, WorktreeStatus } from '@deepseek-ai/dsh-worktree/types'

/** One durable worktree projected to clients. */
export interface WorktreeView {
  readonly worktreeId: WorktreeId
  readonly repoPath: string
  readonly path: string
  readonly branch: string
  readonly base: string
  readonly workspaceId?: WorkspaceId
  readonly alias?: string
  readonly createdAt: string
}

/** Default location for a new Session within a repository. */
export type WorktreeModePrefView =
  | { readonly mode: 'checkout'; readonly base?: string | undefined }
  | { readonly mode: 'new'; readonly base?: string | undefined }
  | { readonly mode: 'reuse'; readonly worktreeId: WorktreeId; readonly base?: string | undefined }

/** One read of worktree rows and repository preferences. */
export interface WorktreeListValue {
  readonly items: readonly WorktreeView[]
  readonly prefs: Readonly<Record<string, WorktreeModePrefView>>
}
