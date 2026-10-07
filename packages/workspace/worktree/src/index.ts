/**
 * Worktree registry (`ctx.worktreeRegistry`): git worktree lifecycle over
 * durable per-repo records — create (git worktree add + workspace
 * registration), list, status, removal — plus the per-repository default
 * workspace-mode preference the New Session flow consumes.
 * @module @deepseek-ai/dsh-worktree
 */

import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { realpathNormalize, WorkspaceId as WorkspaceIdBrand } from '@deepseek-ai/dsh-workspace'
import {
  GitCommandError,
  gitCommonRoot,
  resolveBase,
  slugify,
  worktreeAdd,
  worktreeRemove,
  worktreeStatus,
} from './git.ts'
import { worktreeDomainSpec } from './spec.ts'
import type { WorktreeDomainState, WorktreeModePref, WorktreeRecord } from './spec.ts'
import type { WorktreeId as WorktreeIdBrand, WorktreeStatus } from './types.ts'

export type { WorktreeDomainState, WorktreeModePref, WorktreeRecord } from './spec.ts'
export type { WorktreeStatus } from './types.ts'
export { GitCommandError, GitNotARepositoryError, slugify, worktreeStatus } from './git.ts'
export { worktreeDomainSpec, worktreeModePref, worktreeRecord } from './spec.ts'

/** Identifies one worktree record (see `src/types.ts` for the brand rationale). */
export type WorktreeId = WorktreeIdBrand

/**
 * Brand a string as a {@link WorktreeId}.
 * @param id - Raw worktree id string.
 * @returns the same string, branded at compile time.
 */
export function WorktreeId(id: string): WorktreeId {
  return id as WorktreeIdBrand
}

/** Config schema inputs: deployment-varying naming choices, changeable from cordis.yml. */
export interface WorktreeRegistryConfig {
  /** Branch namespace for created worktree branches; `<prefix><slug>`. */
  branchPrefix: string
  /** Sibling-directory suffix for the worktree parent: `<repo><suffix>/<slug>`. */
  parentSuffix: string
}

/** A removal named a worktree id the registry never issued. */
export class WorktreeUnknownError extends Error {
  /**
   * @param id - The unknown worktree id.
   */
  constructor(readonly id: WorktreeId) {
    super(`cannot remove unknown worktree '${id}'`)
    this.name = 'WorktreeUnknownError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    worktreeRegistry: WorktreeRegistry
  }
}

const sortRecords = (leftId: WorktreeId, left: WorktreeRecord, rightId: WorktreeId, right: WorktreeRecord): number =>
  right.createdAt.localeCompare(left.createdAt) || String(leftId).localeCompare(String(rightId))

/**
 * Durable worktree registry. The `worktrees` table IS the registry — display
 * order derives from record timestamps, so one row write is the whole
 * mutation and no order/global divergence is possible; the global singleton
 * holds only the per-repository mode preferences. Git worktree adds run
 * before any durable write: a failed git step leaves nothing registered, and
 * a failed durable write rolls the git side back.
 */
export class WorktreeRegistry extends Service {
  static inject = ['storageDomain', 'workspaceRegistry']

  static Config: z<WorktreeRegistryConfig> = z.object({
    branchPrefix: z.string().default('agent/'),
    parentSuffix: z.string().default('.worktrees'),
  })

  private readonly branchPrefix: string
  private readonly parentSuffix: string
  private table?: KvTable<WorktreeId, WorktreeRecord>
  private global?: DomainGlobal<WorktreeDomainState>
  private state?: WorktreeDomainState
  private readonly records = new Map<WorktreeId, WorktreeRecord>()
  private operationTail: Promise<void> = Promise.resolve()

  /**
   * @param ctx - Owning cordis context.
   * @param config - Validated deployment config (schemastery-filled defaults).
   */
  constructor(ctx: Context, config: WorktreeRegistryConfig) {
    super(ctx, 'worktreeRegistry')
    this.branchPrefix = config.branchPrefix
    this.parentSuffix = config.parentSuffix
  }

  /** Open the domain and rebuild the record cache. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(worktreeDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'worktree.domainClose')
    this.table = domain.table('worktrees')
    this.global = domain.global
    this.state = domain.global.get()
    this.records.clear()
    for (const [id, record] of this.table.entries()) this.records.set(id, record)
  }

  /**
   * Materialize a git worktree for a repository and register it durably. The
   * branch is `<branchPrefix><slug>`; an already-existing branch is checked
   * out as-is (stale-branch reattachment). The worktree directory is also
   * registered as a workspace (title = branch) so sessions group there;
   * workspace-registration failure degrades to an ungrouped worktree with a
   * warning and never fails the create.
   * @param repoPath - Any directory inside the target repository.
   * @param opts - Optional caller-chosen name (slug source) and base ref
   *   (verified; default `origin/main` when locally resolvable, else HEAD).
   * @returns the durable record.
   */
  async create(repoPath: string, opts: { name?: string; base?: string } = {}): Promise<WorktreeRecord> {
    const repo = await this.canonicalRepo(repoPath)
    const slug = await this.uniqueSlug(repo, slugify(opts.name ?? this.defaultName()))
    const worktreePath = join(dirname(repo), `${basename(repo)}${this.parentSuffix}`, slug)
    const branch = `${this.branchPrefix}${slug}`
    const base = await resolveBase(repo, opts.base)
    await worktreeAdd(repo, worktreePath, branch, base)

    let workspaceId: string | undefined
    let workspaceRegistered = false
    try {
      const workspace = await this.ctx.workspaceRegistry.create(worktreePath, branch)
      workspaceId = String(workspace.id)
      workspaceRegistered = true
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `worktree '${slug}' was created but its workspace registration failed: ${String(error)}`,
      )
    }

    const id = WorktreeId(randomUUID())
    const record: WorktreeRecord = {
      id,
      repoPath: repo,
      path: worktreePath,
      branch,
      base,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      createdAt: new Date().toISOString(),
    }
    try {
      await this.enqueueOperation(async () => {
        this.records.set(id, record)
        try {
          await this.requireTable().put(id, record)
        } catch (error) {
          this.records.delete(id)
          throw error
        }
      })
    } catch (error) {
      // The durable write is the commit point: before it lands, the git
      // side and the workspace registration roll back so no registered
      // worktree exists without its record.
      if (workspaceId !== undefined) {
        await this.ctx.workspaceRegistry.delete(WorkspaceIdBrand(workspaceId)).catch(() => {})
      }
      await worktreeRemove(repo, worktreePath, true).catch(() => {})
      if (workspaceRegistered) this.ctx.logger.warn(`worktree '${slug}' create was rolled back after a registry write failure`)
      throw error
    }
    return record
  }

  /**
   * Ordered worktree records, newest first.
   * @param repoPath - When given, only worktrees of the repository owning
   *   that directory are returned.
   * @returns a fresh ordered array of records.
   */
  async list(repoPath?: string): Promise<WorktreeRecord[]> {
    const repo = repoPath === undefined ? undefined : await this.canonicalRepo(repoPath)
    return [...this.records.entries()]
      .filter(([, record]) => repo === undefined || record.repoPath === repo)
      .sort(([leftId, left], [rightId, right]) => sortRecords(leftId, left, rightId, right))
      .map(([, record]) => ({ ...record }))
  }

  /**
   * Look up one worktree record by id.
   * @param id - Worktree id.
   * @returns the record, or `undefined` when unknown.
   */
  get(id: WorktreeId): WorktreeRecord | undefined {
    const record = this.records.get(id)
    return record === undefined ? undefined : { ...record }
  }

  /**
   * The live git projection of one working directory: branch, head, dirty
   * flag, repo-global stash count, and upstream divergence. Not a registry
   * query — any git working directory (including a plain checkout) reports.
   * @param path - Working directory to query.
   * @returns the status bundle.
   */
  async status(path: string): Promise<WorktreeStatus> {
    const canonical = await realpathNormalize(path)
    return { path: canonical, ...await worktreeStatus(canonical) }
  }

  /**
   * Read the per-repository default workspace mode for new sessions.
   * @param repoPath - Any directory inside the repository.
   * @returns the stored preference, or `undefined` when the repo has none.
   */
  async pref(repoPath: string): Promise<WorktreeModePref | undefined> {
    const repo = await this.canonicalRepo(repoPath)
    return this.requireState().prefs[repo]
  }

  /**
   * Write the per-repository default workspace mode for new sessions.
   * @param repoPath - Any directory inside the repository.
   * @param pref - The preference: the checkout, a fresh worktree per
   *   session, or a named existing worktree.
   * @returns resolution after durability.
   */
  async setPref(repoPath: string, pref: WorktreeModePref): Promise<void> {
    const repo = await this.canonicalRepo(repoPath)
    await this.enqueueOperation(async () => {
      const state = this.requireState()
      const next: WorktreeDomainState = { ...state, prefs: { ...state.prefs, [repo]: pref } }
      await this.requireGlobal().set(next)
      this.state = next
    })
  }

  /**
   * Remove one worktree: `git worktree remove` (refuses a dirty tree unless
   * forced) plus the durable record deletion. The branch is never deleted —
   * merge-back keeps it. A git removal of an already-missing worktree
   * directory is accepted so the record can still be cleared.
   * @param id - Worktree record to remove.
   * @param opts - `force: true` removes even a dirty worktree.
   * @returns resolution after durability.
   */
  async remove(id: WorktreeId, opts: { force?: boolean } = {}): Promise<void> {
    const record = this.records.get(id)
    if (record === undefined) throw new WorktreeUnknownError(id)
    try {
      await worktreeRemove(record.repoPath, record.path, opts.force === true)
    } catch (error: unknown) {
      // An externally deleted worktree directory still owns its durable
      // record; git's not-a-working-tree complaint means the removal already
      // happened, so falling through clears the stale registration.
      if (!(error instanceof GitCommandError)
        || !/not a working tree|does not exist/i.test(error.stderr)) throw error
    }
    await this.enqueueOperation(async () => {
      this.records.delete(id)
      try {
        await this.requireTable().delete(id)
      } catch (error) {
        this.records.set(id, record)
        throw error
      }
    })
  }

  /** Canonicalize any directory of a repository (or its worktrees) to the shared main repo root. */
  private async canonicalRepo(repoPath: string): Promise<string> {
    return await realpathNormalize(await gitCommonRoot(await realpathNormalize(repoPath)))
  }

  /**
   * Uniquify a slug inside a repository's worktree parent: the bare slug
   * when free, otherwise `-2`, `-3`, … past every existing directory.
   */
  private async uniqueSlug(repo: string, slug: string): Promise<string> {
    const parent = join(dirname(repo), `${basename(repo)}${this.parentSuffix}`)
    let candidate = slug
    for (let attempt = 2; await this.exists(join(parent, candidate)); attempt += 1) {
      candidate = `${slug}-${attempt}`
    }
    return candidate
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  /** Timestamp-based default slug (`wt-20260101-120000`). */
  private defaultName(): string {
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `wt-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  }

  private requireTable(): KvTable<WorktreeId, WorktreeRecord> {
    if (this.table === undefined) throw new Error('worktree registry is not started yet')
    return this.table
  }

  private requireGlobal(): DomainGlobal<WorktreeDomainState> {
    if (this.global === undefined) throw new Error('worktree registry is not started yet')
    return this.global
  }

  private requireState(): WorktreeDomainState {
    if (this.state === undefined) throw new Error('worktree registry is not started yet')
    return this.state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

export default WorktreeRegistry
