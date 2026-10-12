/** WorkspaceRuntime projects the Workspace object manager for UI consumers. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  DirectoryListing, IApiClient, RpcError,
  SessionId, WorkspaceId, WorkspaceView,
  WorktreeModePrefView, WorktreeStatusView, WorktreeView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '../contract/store.ts'
import { createSnapshotStore } from '../contract/store.ts'
import type { SessionsPort, SessionsPortList } from '../contract/sessions-port.ts'
import type { IWorkspaces } from '../contract/workspaces.ts'
import { WorkspaceManager, type WorkspaceListPhase } from './manager.ts'

/**
 * Worktree projection the runtime owns alongside the workspace baseline: the
 * records per canonical repository path, the per-repository default
 * workspace-mode preference, and the workspaceId → worktree-name map the
 * sidebar uses for its `<worktree>/<title>` session prefix. Refreshed from
 * `worktree.list` on demand (first baseline, after every mutation).
 */
export interface WorkspaceWorktreeState {
  /** Known worktree records per canonical repository path, newest first. */
  byRepo: Readonly<Record<string, readonly WorktreeView[]>>
  /** Per-repository default workspace mode keyed by canonical repository path. */
  prefs: Readonly<Record<string, WorktreeModePrefView>>
  /** Workspace ids registered over worktree directories → worktree directory name. */
  namesByWorkspaceId: Readonly<Record<string, string>>
}

/** Worktree projection carried by the workspace list state. */
export interface WorkspaceListStateWorktrees {
  /** See {@link WorkspaceWorktreeState}. */
  worktrees: WorkspaceWorktreeState
}

/** Workspace list plus the two-baseline readiness and default-target projection. */
export interface WorkspaceListState extends WorkspaceListStateWorktrees {
  items: readonly WorkspaceView[]
  /**
   * Registry-global archive set in Host order: grouping surfaces hide these
   * sessions everywhere (workspace groups and the ungrouped bucket) while
   * their session logs and workspace accounting slots remain. A plain array
   * (store-engine vocabulary; immer drafts reject Sets) — membership lookups
   * build their own transient Set.
   */
  archivedSessionIds: readonly SessionId[]
  state: 'idle' | 'loading' | 'error'
  phase: WorkspaceListPhase
  error: RpcError | null
  /** True only after both workspace.list and session.list have succeeded. */
  baselinesReady: boolean
  /** Most recently active Workspace, derived without changing `items` order. */
  recentWorkspaceId: WorkspaceId | undefined
}

/** Structured create failure for UI flows that distinguish Host business errors. */
export class WorkspaceCreateError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(`workspace create failed: ${rpcError.code}: ${rpcError.message}`)
    this.name = 'WorkspaceCreateError'
  }
}

/** Structured worktree failure (create / preference write / status query) for UI flows. */
export class WorktreeActionError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(`worktree action failed: ${rpcError.code}: ${rpcError.message}`)
    this.name = 'WorktreeActionError'
  }
}

/** The empty worktree projection (no records, no preferences). */
export function emptyWorktreeState(): WorkspaceWorktreeState {
  return { byRepo: {}, prefs: {}, namesByWorkspaceId: {} }
}

/** Structured browse failure so the directory browser can branch on Host business codes. */
export class DirectoryBrowseError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
    this.name = 'DirectoryBrowseError'
  }
}

/** Real Workspace object layer and Host actions. */
export class WorkspaceRuntime implements IWorkspaces {
  /** UI-facing immutable projection; the manager remains wire truth. */
  readonly list: SnapshotStore<WorkspaceListState>
  /** Workspace baseline and frame owner. */
  private readonly manager: WorkspaceManager
  /** In-flight blank-session creates keyed by workspace (connectWorkspace coalescing). */
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>()
  /** Guards the runtime-owned one-shot initial-selection subscription. */
  private initialSelectionStarted = false
  /** Guards repeated worktree.list pulls before the first success lands. */
  private worktreeRefreshInFlight: Promise<void> | undefined

  /**
   * @param ctx - client root context.
   * @param api - shared wire client.
   * @param sessions - cross-domain sessions face used for recency and blank-session reuse.
   */
  constructor(ctx: Context, private readonly api: IApiClient, private readonly sessions: SessionsPort) {
    this.manager = new WorkspaceManager(api)
    this.list = createSnapshotStore<WorkspaceListState>({
      items: [], archivedSessionIds: [], state: 'idle', phase: 'pending', error: null,
      baselinesReady: false, recentWorkspaceId: undefined, worktrees: emptyWorktreeState(),
    })
    this.manager.subscribe(() => { this.project() })
    this.sessions.list.subscribe(() => { this.project() })
    ctx.reflect.provide('workspaces', this, undefined)
  }

  /**
   * Resolve the session a New Session flow lands in once this Workspace is
   * chosen: reuse the workspace's existing blank session when one is in the
   * list mirror, else create a fresh one on the host (`session.create` births
   * the full Session+Agent — the client holds no intermediate state). The
   * caller owns navigation: take the returned id to `sessions.open`.
   * Resolution guarantee (both arms): the returned id is already in the list
   * store and `sessions.binding(id)` resolves synchronously — draft hand-off
   * may write the new scope's machine before opening.
   * @param workspaceId - chosen Workspace (must be in the workspace list).
   * @returns the reused or newly created session id.
   */
  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    const workspace = this.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) throw new Error(`workspaces.connectWorkspace: unknown workspace ${workspaceId}`)
    // Coalesce concurrent connects: a create's summary lands without cwd
    // until the host frame arrives, so a second call inside that window
    // would miss the reuse scan and mint another hidden blank session.
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined) return inflight
    // Reuse requires workspace membership (id in sessionIds AND same
    // canonical cwd — the host's own membership rule), never cwd alone:
    // a cwd match can belong to no account (sessions the CLI/TUI birthed at
    // the host cwd, or a deleted/recreated registration) and reusing it
    // would open a session no grouping surface shows under this workspace.
    // An archived blank is never reused either: reuse would open a session
    // no grouping surface can show, so New Session mints a fresh one instead.
    const archived = this.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary !== undefined && summary.blank && summary.cwd === workspace.path
        && workspace.sessionIds.includes(summary.id)
        && !archived.includes(summary.id)) return summary.id
    }
    const attempt = this.sessions.create({ workspaceId })
      .finally(() => { this.connecting.delete(workspaceId) })
    this.connecting.set(workspaceId, attempt)
    return attempt
  }

  /**
   * Follow the first complete Workspace/Session baseline and select a default
   * session exactly once. A restored current session wins; otherwise the most
   * recent Workspace is connected (reusing or creating its blank session).
   * Later explicit clears stay cleared instead of retriggering this startup
   * policy. A failed connect may retry on the next baseline projection.
   * @returns disposer for the baseline subscription; late work cannot navigate after disposal.
   */
  startInitialSelection(): () => void {
    if (this.initialSelectionStarted) {
      throw new Error('workspaces.startInitialSelection: already started')
    }
    this.initialSelectionStarted = true
    let state: 'waiting' | 'connecting' | 'done' = 'waiting'
    let disposed = false
    const reconcile = (): void => {
      if (disposed || state !== 'waiting') return
      const workspace = this.list.getSnapshot()
      if (!workspace.baselinesReady) return
      // First complete baseline is also the worktree projection's boot hook:
      // one pull so the sidebar prefix and mode defaults are ready without
      // waiting for a first user interaction. Failures retry on the next
      // explicit refresh (mutation or UI mount), never block selection.
      void this.refreshWorktrees().catch((reason: unknown) => {
        console.warn('worktree projection refresh failed:', reason)
      })
      const current = this.sessions.list.getSnapshot().current
      const target = workspace.recentWorkspaceId
      if (current !== undefined || target === undefined) {
        state = 'done'
        return
      }
      state = 'connecting'
      void this.connectWorkspace(target).then(
        (sessionId) => {
          if (disposed) return
          if (this.sessions.list.getSnapshot().current === undefined) {
            this.sessions.open(sessionId)
          }
          state = 'done'
        },
        (reason: unknown) => {
          if (disposed) return
          state = 'waiting'
          console.warn('initial workspace selection failed:', reason)
        },
      )
    }
    const unsubscribe = this.list.subscribe(reconcile)
    reconcile()
    return () => {
      disposed = true
      unsubscribe()
    }
  }

  /**
   * The shared New Session action behind the shell entry points (sidebar
   * button, workspace browser): resolve the target Workspace — explicit wins,
   * then the current Session's Workspace, then the recent-Workspace
   * projection — connect its blank session and navigate there; with no
   * Workspace at all, clear the selection into the New Session view state.
   * The target workspace's effective mode intercepts first: a stored `new`
   * preference, or a git repository with no stored preference, materializes
   * a fresh worktree (and its workspace) before connecting; `reuse` connects
   * the named worktree's workspace; anything else (an explicit checkout, a
   * failed worktree step, a vanished reuse record) connects the checkout.
   * Connect failures are non-fatal (console diagnostics; the current view
   * stays usable).
   * @param workspaceId - explicit target Workspace for scoped actions.
   */
  startSession(workspaceId?: WorkspaceId): void {
    void this.startSessionIn(workspaceId).catch((reason: unknown) => {
      console.warn('start session failed:', reason)
    })
  }

  /**
   * True when the directory is inside a git repository: one bounded
   * `worktree.status` query; the host answers `worktree-not-a-repository`
   * for everything else. Only the effective-default path pays for this —
   * a stored preference decides without a query.
   */
  private async isGitRepository(path: string): Promise<boolean> {
    try {
      await this.worktreeStatus(path)
      return true
    } catch {
      return false
    }
  }

  /** Connect a workspace's blank session and navigate to it (the one landing rule). */
  private async openInWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const sessionId = await this.connectWorkspace(workspaceId)
    this.sessions.open(sessionId)
  }

  /** Async body of {@link startSession}; see it for the contract. */
  private async startSessionIn(workspaceId?: WorkspaceId): Promise<void> {
    const workspace = this.list.getSnapshot()
    const current = this.sessions.list.getSnapshot().current
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId
    const target = workspaceId ?? currentWorkspaceId ?? workspace.recentWorkspaceId
    if (target === undefined) {
      this.sessions.clear()
      return
    }
    const targetWorkspace = workspace.items.find(item => item.workspaceId === target)
    const resolved = targetWorkspace === undefined ? undefined : this.resolvePref(targetWorkspace.path)
    const pref = resolved?.pref
    if (targetWorkspace !== undefined
      && (pref?.mode === 'new' || (pref === undefined && await this.isGitRepository(targetWorkspace.path)))) {
      try {
        const { worktree, workspace: created } = await this.createWorktree({
          repoPath: targetWorkspace.path, ...(pref?.base === undefined ? {} : { base: pref.base }),
        })
        const landingId = created?.workspaceId ?? worktree.workspaceId
        if (landingId === undefined) return await this.openInWorkspace(target)
        // The workspace row travels the host stream; the fresh record is
        // already in the projection, so a bounded wait resolves the row
        // without a silent checkout fallback.
        const landing = await this.waitForWorkspace(landingId)
        return await this.openInWorkspace(landing === undefined ? target : landing.workspaceId)
      } catch (reason: unknown) {
        // A failing worktree step (git error, registration failure) lands the
        // session in the checkout instead of leaving the user with nothing.
        console.warn('new worktree session failed; connecting the checkout instead:', reason)
        return await this.openInWorkspace(target)
      }
    }
    if (targetWorkspace !== undefined && pref?.mode === 'reuse') {
      const reused = Object.values(workspace.worktrees.byRepo).flat()
        .find(record => record.worktreeId === pref.worktreeId && record.workspaceId !== undefined)
      if (reused?.workspaceId !== undefined) {
        return await this.openInWorkspace(reused.workspaceId)
      }
      // The preferred worktree is gone (removed or its registration failed at
      // create): the stored preference can never resolve again, so clear it —
      // keyed by the canonical repository, not the workspace path.
      void this.setWorktreePref(resolved?.repoKey ?? targetWorkspace.path, { mode: 'checkout' }).catch(() => {})
    }
    await this.openInWorkspace(target)
  }

  /**
   * Reload the worktree projection (records + per-repo preferences) from the
   * Host. Coalesced: a second call while one is in flight awaits it.
   * @returns completion of the current or newly started worktree pull.
   */
  async refreshWorktrees(): Promise<void> {
    if (this.worktreeRefreshInFlight !== undefined) return this.worktreeRefreshInFlight
    const pull = this.api.worktree.list({}).then((response) => {
      if (!response.result.ok) throw new WorktreeActionError(response.result.error)
      const { items, prefs } = response.result.value
      const byRepo: Record<string, WorktreeView[]> = {}
      const namesByWorkspaceId: Record<string, string> = {}
      for (const record of items) {
        (byRepo[record.repoPath] ??= []).push(record)
        if (record.workspaceId !== undefined) {
          // The claimed alias (the titling session's slugified title) reads
          // better than the timestamp default the directory was created with.
          namesByWorkspaceId[record.workspaceId] = record.alias
            ?? record.path.split('/').filter(Boolean).at(-1)
            ?? record.path
        }
      }
      const previous = this.list.getSnapshot().worktrees.prefs
      this.list.update((draft) => {
        draft.worktrees = {
          byRepo,
          namesByWorkspaceId,
          prefs: { ...previous, ...prefs },
        }
      })
    }).finally(() => { this.worktreeRefreshInFlight = undefined })
    this.worktreeRefreshInFlight = pull
    return pull
  }

  /**
   * Materialize a git worktree for a workspace's repository and register it
   * durably. The projection refreshes before resolution so the next reader
   * sees the new record; the registered workspace row itself arrives on the
   * Host workspace stream and is resolved best-effort from the live list.
   * @param input - the repository (any directory inside it), optional slug
   *   source name, and optional verified base ref.
   * @returns the record plus its registered workspace, when visible yet.
   */
  async createWorktree(
    input: { repoPath: string; name?: string; base?: string },
  ): Promise<{ worktree: WorktreeView; workspace: WorkspaceView | undefined }> {
    const response = await this.api.worktree.create(input)
    if (!response.result.ok) throw new WorktreeActionError(response.result.error)
    const worktree = response.result.value.worktree
    await this.refreshWorktrees()
    const workspace = worktree.workspaceId === undefined
      ? undefined
      : this.list.getSnapshot().items.find(item => item.workspaceId === worktree.workspaceId)
    return { worktree, workspace }
  }

  /**
   * Write the per-repository default workspace mode for new sessions and
   * refresh the projection from the authoritative response.
   * @param repoPath - the repository (any directory inside it).
   * @param pref - checkout, fresh-worktree-per-session, or a named worktree.
   */
  async setWorktreePref(repoPath: string, pref: WorktreeModePrefView): Promise<void> {
    const response = await this.api.worktree.setPref({ repoPath, pref })
    if (!response.result.ok) throw new WorktreeActionError(response.result.error)
    this.list.update((draft) => {
      draft.worktrees = { ...draft.worktrees, prefs: { ...draft.worktrees.prefs, [repoPath]: pref } }
    })
  }

  /**
   * Live git status of one working directory (branch, stash count, dirty …).
   * @param path - working directory to query.
   * @param signal - aborts the wire request when the caller supersedes it.
   * @returns the status bundle.
   */
  async worktreeStatus(path: string, signal?: AbortSignal): Promise<WorktreeStatusView> {
    const response = await this.api.worktree.status({ path }, signal)
    if (!response.result.ok) throw new WorktreeActionError(response.result.error)
    return response.result.value
  }

  /**
   * The per-repository default mode governing a workspace path, with the
   * canonical repository key it is stored under: the exact key wins, else the
   * longest recorded repository key that contains the path — as a child path
   * (`repo/…`) or the worktree sibling layout (`repo.worktrees/…`).
   * `undefined` means no stored preference — the checkout.
   * @param path - canonical workspace path.
   * @returns the governing preference with its repository key, when one exists.
   */
  private resolvePref(path: string): { repoKey: string; pref: WorktreeModePrefView } | undefined {
    const prefs = this.list.getSnapshot().worktrees.prefs
    if (prefs[path] !== undefined) return { repoKey: path, pref: prefs[path] as WorktreeModePrefView }
    let best: string | undefined
    let bestPref: WorktreeModePrefView | undefined
    for (const [repo, pref] of Object.entries(prefs)) {
      const contained = path === repo || path.startsWith(`${repo}/`) || path.startsWith(`${repo}.`)
      if (contained && (best === undefined || repo.length > best.length)) {
        best = repo
        bestPref = pref
      }
    }
    return best === undefined || bestPref === undefined ? undefined : { repoKey: best, pref: bestPref }
  }

  /**
   * Bounded wait for a workspace row to arrive on the workspace stream.
   * @param workspaceId - the row to wait for.
   * @returns the row, or `undefined` once the bounded wait expires.
   */
  private async waitForWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceView | undefined> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const found = this.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
      if (found !== undefined) return found
      await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    }
    return undefined
  }

  /**
   * Register an existing path as a Workspace.
   * @param input - the Host create payload.
   * @returns the created or idempotently resolved Workspace.
   */
  async create(input: { path: string }): Promise<WorkspaceView> {
    const result = await this.manager.create(input)
    if (!result.ok) throw new WorkspaceCreateError(result.error)
    return result.value.workspace
  }

  /**
   * Open the Host's native directory picker (the `native` capability).
   * @returns the selected path, or null when the user cancelled.
   */
  async pickDirectory(): Promise<string | null> {
    const response = await this.api.host.pickDirectory({})
    if (!response.result.ok) {
      throw new Error(`directory picker failed: ${response.result.error.message}`)
    }
    return response.result.value.path
  }

  /**
   * List one directory level through the Host's `browse` capability.
   * @param path - absolute directory to list; absent lists the Host home directory.
   * @param opts - level options; `includeFiles` widens the rows past enterable directories.
   * @param signal - aborts the wire request (and the Host's scan) when the caller supersedes it.
   * @returns the level's listing with breadcrumb ancestry.
   */
  async listDirectory(path?: string, opts?: { includeFiles?: boolean }, signal?: AbortSignal): Promise<DirectoryListing> {
    const response = await this.api.host.listDirectory(
      path === undefined && opts?.includeFiles !== true
        ? {}
        : { ...(path === undefined ? {} : { path }), ...(opts?.includeFiles === true ? { includeFiles: true } : {}) },
      signal,
    )
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
    return response.result.value
  }

  /**
   * Create one child directory through the Host's `browse` capability.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank path segment.
   * @returns the created directory's absolute path.
   */
  async createDirectory(path: string, name: string): Promise<string> {
    const response = await this.api.host.createDirectory({ path, name })
    if (!response.result.ok) throw new DirectoryBrowseError(response.result.error)
    return response.result.value.path
  }

  /**
   * Open a filesystem path with the Host operating system's default application.
   * @param path - absolute or host-resolvable path.
   */
  async openPath(path: string): Promise<void> {
    const response = await this.api.host.openPath({ path })
    if (!response.result.ok) {
      throw new Error(`path open failed: ${response.result.error.message}`)
    }
  }

  /**
   * Read one text file inline (see the contract); one bounded wire read.
   * @param path - absolute or host-resolvable path.
   * @returns the content and truncation flag.
   */
  async readTextFile(path: string): Promise<{ content: string; truncated: boolean }> {
    const response = await this.api.host.readTextFile({ path })
    if (!response.result.ok) {
      throw new Error(`text read failed: ${response.result.error.message}`)
    }
    return response.result.value
  }

  /**
   * Rename a Workspace.
   * @param workspaceId - target workspace.
   * @param title - new display title (trimmed non-empty by the Host).
   * @returns the renamed Workspace view.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    const result = await this.manager.rename(workspaceId, title)
    if (!result.ok) throw new Error(`workspace rename failed: ${result.error.code}: ${result.error.message}`)
    return result.value.workspace
  }

  /**
   * Delete one Workspace registration. Sessions, session logs, and the
   * directory remain Host-owned outside this operation.
   * @param workspaceId - target workspace.
   */
  async delete(workspaceId: WorkspaceId): Promise<void> {
    const result = await this.manager.delete(workspaceId)
    if (!result.ok) throw new Error(`workspace delete failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Move a Workspace within the durable registry display order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor workspace; omitted appends.
   */
  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    const result = await this.manager.insertBefore(workspaceId, beforeWorkspaceId)
    if (!result.ok) throw new Error(`workspace reorder failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Archive a session into the registry-global set. Clearing an archived
   * current selection is the projection sweep's job (one rule for the local
   * echo and a remote tab's frame alike).
   * @param sessionId - session to archive.
   */
  async archiveSession(sessionId: SessionId): Promise<void> {
    const result = await this.manager.archiveSession(sessionId)
    if (!result.ok) throw new Error(`session archive failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Move a session within its Workspace's manual order (DOM-insertBefore-like).
   * @param workspaceId - owning workspace.
   * @param sessionId - accounted session to move.
   * @param beforeSessionId - accounted anchor to insert before; omitted appends.
   * @returns the updated Workspace view.
   */
  async insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    const result = await this.manager.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    if (!result.ok) throw new Error(`workspace move failed: ${result.error.code}: ${result.error.message}`)
    return result.value.workspace
  }

  /**
   * Refresh the workspace baseline, reusing an in-flight pull.
   * @returns completion of the current or newly started workspace baseline pull.
   */
  refresh(): Promise<void> {
    return this.manager.refresh()
  }

  /**
   * Route a Host stream envelope into the Workspace object layer.
   * @param envelope - validated Host stream envelope.
   */
  handleHostEnvelope(envelope: Parameters<WorkspaceManager['handleHostEnvelope']>[0]): void {
    this.manager.handleHostEnvelope(envelope)
  }

  /** Rebuild the Workspace baseline after connection. */
  handleConnected(): void {
    this.manager.handleConnected()
  }

  private project(): void {
    const workspace = this.manager.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const baselinesReady = workspace.phase === 'ready' && sessions.phase === 'ready'
    // An archived current selection clears into the New Session view state —
    // a hidden row must not stay open behind the list. Sweeping here covers
    // every install path with one rule: the local unary echo, another tab's
    // changed frame, and a reconnect baseline restoring a persisted
    // selection that was archived while this client was away.
    if (sessions.current !== undefined && workspace.archivedSessionIds.includes(sessions.current)) {
      this.sessions.clear()
    }
    this.list.set({
      items: workspace.items,
      archivedSessionIds: workspace.archivedSessionIds,
      state: workspace.state,
      phase: workspace.phase,
      error: workspace.error,
      baselinesReady,
      recentWorkspaceId: baselinesReady ? recentWorkspace(workspace.items, sessions.byId) : undefined,
      worktrees: this.list.getSnapshot().worktrees,
    })
  }
}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionsPortList['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}
