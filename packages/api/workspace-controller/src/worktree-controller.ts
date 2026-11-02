/** Host Remote adapter over the durable worktree registry. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { WorktreeId, WorktreeStatus } from '@deepseek-ai/dsh-worktree/types'
import type { WorktreeRecord } from '@deepseek-ai/dsh-worktree'
import type { WorktreeListValue, WorktreeModePrefView, WorktreeView } from './worktree-types.ts'

/** Project one durable record without its internal alias owner. */
function view(record: WorktreeRecord): WorktreeView {
  return {
    worktreeId: record.id,
    repoPath: record.repoPath,
    path: record.path,
    branch: record.branch,
    base: record.base,
    ...(record.workspaceId === undefined ? {} : { workspaceId: WorkspaceId(record.workspaceId) }),
    ...(record.alias === undefined ? {} : { alias: record.alias }),
    createdAt: record.createdAt,
  }
}

/** Remote namespace for worktree operations used by browser features. */
export class WorktreeController extends TypertRemoteService {
  static inject = ['typert', 'worktreeRegistry']

  /** @param ctx - Host context containing the durable worktree registry. */
  constructor(ctx: Context) {
    super(ctx, 'worktreeController', { namespace: 'worktree' })
  }

  /** @param request - optional repository filter. @returns worktrees and saved mode preferences. */
  @Remote
  async list(request: { repoPath?: string }): Promise<WorktreeListValue> {
    return { items: (await this.ctx.worktreeRegistry.list(request.repoPath)).map(view), prefs: this.ctx.worktreeRegistry.prefs() }
  }

  /** @param request - repository, name, and base. @returns created worktree. */
  @Remote
  async create(request: { repoPath: string; name?: string; base?: string }): Promise<{ worktree: WorktreeView }> {
    const record = await this.ctx.worktreeRegistry.create(request.repoPath, request)
    return { worktree: view(record) }
  }

  /** @param request - working directory. @returns live git status. */
  @Remote
  status(request: { path: string }, signal: AbortSignal): Promise<WorktreeStatus> {
    void signal
    return this.ctx.worktreeRegistry.status(request.path)
  }

  /** @param request - repository path. @returns saved preference or null. */
  @Remote
  async pref(request: { repoPath: string }): Promise<{ pref: WorktreeModePrefView | null }> {
    return { pref: await this.ctx.worktreeRegistry.pref(request.repoPath) ?? null }
  }

  /** @param request - repository and preference. @returns durable save receipt. */
  @Remote
  async setPref(request: { repoPath: string; pref: WorktreeModePrefView }): Promise<{ saved: true }> {
    await this.ctx.worktreeRegistry.setPref(request.repoPath, request.pref)
    return { saved: true }
  }

  /** @param request - worktree id and force choice. @returns deletion receipt. */
  @Remote
  async remove(request: { worktreeId: WorktreeId; force?: boolean }): Promise<{ removed: true }> {
    await this.ctx.worktreeRegistry.remove(request.worktreeId, request)
    return { removed: true }
  }
}
