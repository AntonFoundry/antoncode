/** Test-owned workspaces face: the renderer standard-kit observable plus recorded actions. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type {
  WorktreeId, WorktreeModePrefView, WorktreeStatus as WorktreeStatusView, WorktreeView,
} from '@deepseek-ai/dsh-api-workspace-controller/worktree-types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { workspaceSnapshot } from './fixtures.ts'
import type { FixtureSnapshot, Stabilizer } from './fixtures.ts'

/** Writable test representation of the immutable Workspace Controller snapshot. */
type WorkspaceFixtureSnapshot = FixtureSnapshot<WorkspaceSnapshot>

/** Callable command names on the production Workspace Controller face. */
type WorkspaceAction = {
  [Key in keyof IWorkspaces]: IWorkspaces[Key] extends (...args: never[]) => unknown ? Key : never
}[keyof IWorkspaces] | 'openPath' | 'readTextFile' | 'pickDirectory' | 'listDirectory' | 'createDirectory'

/** Test replacement retaining one Controller command's parameters and result. */
type WorkspaceStub<Key extends WorkspaceAction> = Key extends keyof IWorkspaces
  ? IWorkspaces[Key] extends (...args: never[]) => unknown ? IWorkspaces[Key] : never
  : (...args: never[]) => unknown

/**
 * Workspaces test double. Implements the same IWorkspaces face features
 * receive as `ctx.workspaces`, so a production face change breaks this
 * double at compile time. Every action records into {@link
 * TestWorkspaces.calls}; defaults are inert echoes — feature tests needing
 * richer behavior replace them via {@link TestWorkspaces.stub}.
 */
export class TestWorkspaces implements IWorkspaces {
  /** The useWorkspaces standard feed. */
  readonly list: SnapshotStore<WorkspaceFixtureSnapshot>

  /** Calls observed on the action face, newest last. */
  readonly calls: { method: string; args: unknown[] }[] = []

  /** Replaceable action seat: feature tests may stub richer behavior. */
  private readonly stubs = new Map<WorkspaceAction, (...args: unknown[]) => unknown>()

  /**
   * @param stabilize - the owning runtime's act wrapper.
   */
  constructor(private readonly stabilize: Stabilizer) {
    this.list = createSnapshotStore<WorkspaceFixtureSnapshot>({ ...workspaceSnapshot() })
  }

  /**
   * Update the workspace list state through an immer draft.
   * @param mutate - draft mutator.
   */
  async update(mutate: (draft: WorkspaceFixtureSnapshot) => void): Promise<void> {
    await this.stabilize(() => { this.list.update(mutate) })
  }

  /**
   * Replace an action's behavior (the recorded call is still appended first).
   * @param method - Controller action name (e.g. 'create').
   * @param impl - replacement behavior.
   */
  stub<Key extends WorkspaceAction>(method: Key, impl: WorkspaceStub<Key>): void {
    this.stubs.set(method, impl as (...args: unknown[]) => unknown)
  }

  /**
   * Worktree projection reload (recorded). The default resolves immediately;
   * tests shape the projection through {@link update}.
   */
  async refreshWorktrees(): Promise<void> {
    this.calls.push({ method: 'refreshWorktrees', args: [] })
    await (this.stubs.get('refreshWorktrees')?.() as Promise<void> | undefined)
  }

  /**
   * Worktree create (recorded). The default echoes a synthetic record with no
   * workspace; stub for failure or workspace-coupled flows.
   * @param input - the Host create payload.
   * @returns the record plus its workspace (undefined by default).
   */
  async createWorktree(
    input: { repoPath: string; name?: string; base?: string },
  ): Promise<WorktreeView> {
    this.calls.push({ method: 'createWorktree', args: [input] })
    const stub = this.stubs.get('createWorktree')
    if (stub !== undefined) return await (stub(input) as Promise<WorktreeView>)
    const slug = input.name ?? 'wt'
    return {
      worktreeId: `wt-${input.repoPath}-${slug}` as WorktreeId,
      repoPath: input.repoPath,
      path: `${input.repoPath}.worktrees/${slug}`,
      branch: `agent/${slug}`,
      base: input.base ?? 'origin/main',
      createdAt: new Date().toISOString(),
    }
  }

  /**
   * Per-repo default mode write (recorded; default no-op).
   * @param repoPath - the repository path.
   * @param pref - the mode preference.
   */
  async setWorktreePref(repoPath: string, pref: WorktreeModePrefView): Promise<void> {
    this.calls.push({ method: 'setWorktreePref', args: [repoPath, pref] })
    await (this.stubs.get('setWorktreePref')?.(repoPath, pref) as Promise<void> | undefined)
  }

  /**
   * Live git status query (recorded). The default serves a clean main; stub
   * for branch/stash shapes.
   * @param path - working directory to query.
   * @param signal - abort signal (recorded, forwarded to stubs).
   * @returns the status bundle.
   */
  async worktreeStatus(path: string, signal?: AbortSignal): Promise<WorktreeStatusView> {
    this.calls.push({ method: 'worktreeStatus', args: [path, signal] })
    const stub = this.stubs.get('worktreeStatus') as ((p: string, s?: AbortSignal) => Promise<WorktreeStatusView>) | undefined
    if (stub !== undefined) return stub(path, signal)
    return { path, branch: 'main', head: 'test00', dirty: false, stashCount: 0, ahead: 0, behind: 0, bases: ['origin/main', 'HEAD'] }
  }

  /**
   * Create a Workspace (recorded). The default echoes a view derived from
   * the input; stub for failure or list-coupled flows.
   * @param input - the Host create payload.
   * @returns the created Workspace view.
   */
  async create(input: { path: string }): Promise<WorkspaceView> {
    this.calls.push({ method: 'create', args: [input] })
    const stub = this.stubs.get('create')
    if (stub !== undefined) return await (stub(input) as Promise<WorkspaceView>)
    return {
      workspaceId: `ws-${input.path}` as WorkspaceId,
      title: input.path,
      path: input.path,
      sessionIds: [],
    } as unknown as WorkspaceView
  }

  /**
   * Initialize the default Workspace through a test stub; defaults to an ineligible first use.
   * @param signal - caller lifetime.
   * @returns the stubbed Workspace, or undefined when initialization is ineligible.
   */
  async initializeDefault(signal?: AbortSignal): Promise<WorkspaceView | undefined> {
    this.calls.push({ method: 'initializeDefault', args: [signal] })
    const stub = this.stubs.get('initializeDefault')
    return await (stub?.(signal) as Promise<WorkspaceView | undefined> | undefined)
  }

  async openPath(path: string): Promise<void> {
    this.calls.push({ method: 'openPath', args: [path] })
    await (this.stubs.get('openPath')?.(path) as Promise<void> | undefined)
  }

  async readTextFile(path: string): Promise<{ content: string; truncated: boolean }> {
    this.calls.push({ method: 'readTextFile', args: [path] })
    const stub = this.stubs.get('readTextFile') as ((p: string) => Promise<{ content: string; truncated: boolean }>) | undefined
    return stub ? stub(path) : { content: '', truncated: false }
  }

  /**
   * Directory picker (recorded). The default cancels (null); stub to select.
   * @returns the picked path, or null.
   */
  async pickDirectory(): Promise<string | null> {
    this.calls.push({ method: 'pickDirectory', args: [] })
    const stub = this.stubs.get('pickDirectory')
    if (stub !== undefined) return await (stub() as Promise<string | null>)
    return null
  }

  /**
   * Browse listing (recorded). The default serves an empty home level; stub
   * to shape a tree.
   * @param path - absolute directory to list; absent lists the home level.
   * @param opts - level options (recorded and forwarded like production).
   * @param signal - aborts the listing.
   * @returns the level's listing.
   */
  async listDirectory(path?: string, opts?: { includeFiles?: boolean }, signal?: AbortSignal): Promise<DirectoryListing> {
    // The arguments are recorded and forwarded like the production face
    // passes them to the wire, so cancellation and widened-level integration
    // tests can observe or reject on a superseded scan.
    this.calls.push({ method: 'listDirectory', args: [path, opts, signal] })
    const stub = this.stubs.get('listDirectory')
    if (stub !== undefined) return await (stub(path, opts, signal) as Promise<DirectoryListing>)
    // The chain runs root-to-target inclusive, per the DirectoryListing
    // contract — a bare root crumb would mislabel the level in browsers
    // driven by this double.
    return {
      path: '/home/test',
      home: '/home/test',
      crumbs: [
        { name: '/', path: '/', hidden: false, isDirectory: true },
        { name: 'home', path: '/home', hidden: false, isDirectory: true },
        { name: 'test', path: '/home/test', hidden: false, isDirectory: true },
      ],
      entries: [],
      truncated: false,
    }
  }

  /**
   * Browse child creation (recorded). The default joins parent and name.
   * @param path - absolute existing parent directory.
   * @param name - single path segment.
   * @returns the created directory's absolute path.
   */
  async createDirectory(path: string, name: string): Promise<string> {
    this.calls.push({ method: 'createDirectory', args: [path, name] })
    const stub = this.stubs.get('createDirectory')
    if (stub !== undefined) return await (stub(path, name) as Promise<string>)
    return `${path}/${name}`
  }

  /**
   * Rename a Workspace (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param title - new title.
   * @returns the updated view.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    this.calls.push({ method: 'rename', args: [workspaceId, title] })
    const stub = this.stubs.get('rename')
    if (stub !== undefined) return await (stub(workspaceId, title) as Promise<WorkspaceView>)
    return { workspaceId, title, path: `/${title}`, sessionIds: [] } as unknown as WorkspaceView
  }

  /**
   * Delete a Workspace (recorded; default no-op).
   * @param workspaceId - target workspace.
   */
  async delete(workspaceId: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'delete', args: [workspaceId] })
    await (this.stubs.get('delete')?.(workspaceId) as Promise<void> | undefined)
  }

  /**
   * Move a Workspace in display order (recorded; default no-op).
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor; omitted appends.
   */
  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'insertBefore', args: [workspaceId, beforeWorkspaceId] })
    await (this.stubs.get('insertBefore')?.(workspaceId, beforeWorkspaceId) as Promise<void> | undefined)
  }

  /**
   * Move an accounted session (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param sessionId - session to move.
   * @param beforeSessionId - anchor; omitted appends.
   * @returns the updated view.
   */
  async insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView> {
    this.calls.push({ method: 'insertSessionBefore', args: [workspaceId, sessionId, beforeSessionId] })
    const stub = this.stubs.get('insertSessionBefore')
    if (stub !== undefined) return await (stub(workspaceId, sessionId, beforeSessionId) as Promise<WorkspaceView>)
    return { workspaceId, title: '', path: '', sessionIds: [sessionId] } as unknown as WorkspaceView
  }

  /**
   * Archive a session (recorded). The default mirrors the production face's
   * observable effect: the id joins the list state's archive set.
   * @param sessionId - session to archive.
   */
  async archiveSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'archiveSession', args: [sessionId] })
    const stub = this.stubs.get('archiveSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.archivedSessionIds = [...draft.archivedSessionIds, sessionId]
    })
  }

  /**
   * Unarchive a session (recorded). The default mirrors the production face's
   * observable effect: the id leaves the list state's archive set.
   * @param sessionId - session to unarchive.
   */
  async unarchiveSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'unarchiveSession', args: [sessionId] })
    const stub = this.stubs.get('unarchiveSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.archivedSessionIds = draft.archivedSessionIds.filter(id => id !== sessionId)
    })
  }

  /**
   * Pin a session (recorded). The default mirrors the production face's
   * observable effect: the id leads the list state's pin set.
   * @param sessionId - session to pin.
   */
  async pinSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'pinSession', args: [sessionId] })
    const stub = this.stubs.get('pinSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.pinnedSessionIds = [
        sessionId,
        ...draft.pinnedSessionIds.filter(id => id !== sessionId),
      ]
    })
  }

  /**
   * Unpin a session (recorded). The default mirrors the production face's
   * observable effect: the id leaves the list state's pin set.
   * @param sessionId - session to unpin.
   */
  async unpinSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'unpinSession', args: [sessionId] })
    const stub = this.stubs.get('unpinSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.pinnedSessionIds = draft.pinnedSessionIds.filter(id => id !== sessionId)
    })
  }
}
