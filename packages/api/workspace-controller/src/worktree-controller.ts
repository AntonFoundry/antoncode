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

  /**
   * Read registered worktrees and saved mode preferences.
   * @param request - optional repository filter for the worktree rows.
   * @returns matching worktrees and the complete saved mode preference map.
   */
  @Remote
  async list(request: { repoPath?: string }): Promise<WorktreeListValue> {
    return { items: (await this.ctx.worktreeRegistry.list(request.repoPath)).map(view), prefs: this.ctx.worktreeRegistry.prefs() }
  }

  /**
   * Create a worktree through the registry, propagating creation failures.
   * @param request - repository and optional name and base.
   * @returns created worktree without its internal alias owner.
   */
  @Remote
  async create(request: { repoPath: string; name?: string; base?: string }): Promise<{ worktree: WorktreeView }> {
    const record = await this.ctx.worktreeRegistry.create(request.repoPath, request)
    return { worktree: view(record) }
  }

  /**
   * Read Git status through the registry, propagating status failures.
   * @param request - working directory to inspect.
   * @param signal - invocation lifetime; ignored by this operation, so it does not cancel the registry read.
   * @returns current worktree status.
   */
  @Remote
  status(request: { path: string }, signal: AbortSignal): Promise<WorktreeStatus> {
    void signal
    return this.ctx.worktreeRegistry.status(request.path)
  }

  /**
   * Read the repository's saved worktree mode preference.
   * @param request - repository path.
   * @returns saved preference, or null when none is stored.
   */
  @Remote
  async pref(request: { repoPath: string }): Promise<{ pref: WorktreeModePrefView | null }> {
    return { pref: await this.ctx.worktreeRegistry.pref(request.repoPath) ?? null }
  }

  /**
   * Save a repository's worktree mode preference, propagating registry failures.
   * @param request - repository and preference.
   * @returns save receipt after the registry operation resolves.
   */
  @Remote
  async setPref(request: { repoPath: string; pref: WorktreeModePrefView }): Promise<{ saved: true }> {
    await this.ctx.worktreeRegistry.setPref(request.repoPath, request.pref)
    return { saved: true }
  }

  /**
   * Remove a worktree through the registry, propagating removal failures.
   * @param request - worktree id and optional force choice.
   * @returns removal receipt after the registry operation resolves.
   */
  @Remote
  async remove(request: { worktreeId: WorktreeId; force?: boolean }): Promise<{ removed: true }> {
    await this.ctx.worktreeRegistry.remove(request.worktreeId, request)
    return { removed: true }
  }
}
