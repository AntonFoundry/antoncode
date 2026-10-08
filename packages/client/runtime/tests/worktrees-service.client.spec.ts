import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import { WorktreeActionError, WorkspaceRuntime } from '../src/client/workspaces/service.ts'
import { FakeApiClient, err, fakeRemote, ok } from './fake-api.client.ts'

const wid = (id: string): WorkspaceId => id as WorkspaceId

function workspace(id: string, sessionIds: SessionId[] = [], createdAt = '2026-01-01T00:00:00.000Z'): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/w/${id}`, title: id, sessionIds,
    createdAt, updatedAt: createdAt,
  }
}

function worktree(over: {
  worktreeId?: string
  repoPath?: string
  path?: string
  branch?: string
  workspaceId?: string
}) {
  const repoPath = over.repoPath ?? '/w/repo'
  const path = over.path ?? `${repoPath}.worktrees/slug`
  return {
    worktreeId: (over.worktreeId ?? 'wt-1') as never,
    repoPath,
    path,
    branch: over.branch ?? 'agent/slug',
    base: 'origin/main',
    ...(over.workspaceId === undefined ? {} : { workspaceId: over.workspaceId as never }),
    createdAt: '2026-01-02T00:00:00.000Z',
  }
}

/** Booted runtime over a workspace baseline containing one checkout workspace. */
async function booted(options: {
  worktreeItems?: ReturnType<typeof worktree>[]
  prefs?: Record<string, never>
} = {}): Promise<{ api: FakeApiClient; runtime: WorkspaceRuntime }> {
  const api = new FakeApiClient()
  api.onWorkspaceList = () => Promise.resolve(ok({ items: [workspace('repo')] as never[] }))
  api.onWorktreeList = () => Promise.resolve(ok({
    items: (options.worktreeItems ?? []) as never[],
    prefs: options.prefs ?? {},
  }))
  const ctx = new Context()
  const sessions = new SessionRuntime(ctx, api, fakeRemote())
  const runtime = new WorkspaceRuntime(ctx, api, sessions)
  await runtime.refresh()
  await sessions.refresh()
  // The boot hook loads the projection from the first baseline; the tests
  // model it explicitly so interception sees records and preferences.
  await runtime.refreshWorktrees()
  // Worktree workspace rows travel the host stream in production; replay
  // their changed frames so connectWorkspace can resolve them.
  for (const record of options.worktreeItems ?? []) {
    if (record.workspaceId === undefined) continue
    runtime.handleHostEnvelope({
      rpcId: `wt-ws-${record.workspaceId}` as never,
      payload: {
        type: 'host/workspace-changed',
        workspace: { ...workspace(record.workspaceId), path: record.path, title: record.branch },
      },
    } as never)
  }
  // The store projection is microtask-batched; a same-tick startSession would
  // read a stale snapshot (a real user gesture always crosses the boundary).
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  return { api, runtime }
}

describe('worktree projection', () => {
  it('loads records into byRepo with worktree-name resolution and merges prefs', async () => {
    const { api, runtime } = await booted({
      worktreeItems: [worktree({ worktreeId: 'wt-1', workspaceId: 'ws-wt' })],
      prefs: { '/w/repo': { mode: 'new' } as never },
    })
    await runtime.refreshWorktrees()
    const state = runtime.list.getSnapshot().worktrees
    expect(state.byRepo['/w/repo']).toHaveLength(1)
    expect(state.namesByWorkspaceId['ws-wt']).toBe('slug')
    expect(state.prefs['/w/repo']).toEqual({ mode: 'new' })
    // One boot pull (the harness) plus this explicit one.
    expect(api.callsOf('worktree.list')).toHaveLength(2)

    // A later pull's prefs overwrite the same key and keep earlier ones.
    api.onWorktreeList = () => Promise.resolve(ok({
      items: [],
      prefs: { '/w/repo': { mode: 'checkout' } as never, '/w/other': { mode: 'new' } as never },
    }))
    await runtime.refreshWorktrees()
    expect(runtime.list.getSnapshot().worktrees.prefs['/w/repo']).toEqual({ mode: 'checkout' })
    expect(runtime.list.getSnapshot().worktrees.prefs['/w/other']).toEqual({ mode: 'new' })
  })

  it('coalesces concurrent pulls and surfaces business failures as WorktreeActionError', async () => {
    const { api, runtime } = await booted()
    const gate = deferredWorktreeList()
    api.onWorktreeList = () => gate.promise
    const first = runtime.refreshWorktrees()
    const second = runtime.refreshWorktrees()
    gate.resolve(ok({ items: [], prefs: {} }))
    await Promise.all([first, second])
    // The harness boot pull plus the coalesced pair.
    expect(api.callsOf('worktree.list')).toHaveLength(2)

    api.onWorktreeList = () => Promise.resolve(err({ code: 'worktree-not-a-repository', message: 'no repo', details: { path: '/x' } }))
    await expect(runtime.refreshWorktrees()).rejects.toThrow(WorktreeActionError)
  })

  it('refreshes the projection once per boot from the first complete baseline', async () => {
    const { api, runtime } = await booted()
    const spy = vi.spyOn(runtime, 'refreshWorktrees')
    runtime.startInitialSelection()
    await vi.waitFor(() => { expect(spy).toHaveBeenCalled() })
    // The initial selection connected the checkout workspace through the
    // ordinary flow (no intercept without a preference).
    await vi.waitFor(() => {
      expect(api.callsOf('session.create').length).toBeGreaterThan(0)
    })
  })
})

describe('worktree actions', () => {
  it('creates a worktree, refreshes the projection, and resolves the workspace row', async () => {
    const record = worktree({ worktreeId: 'wt-new', workspaceId: 'ws-created' })
    const { api, runtime } = await booted()
    api.onWorktreeCreate = () => Promise.resolve(ok({ worktree: record as never }))
    // The registered workspace row travels the host workspace stream.
    runtime.handleHostEnvelope({
      rpcId: 'wt-ws-created' as never,
      payload: {
        type: 'host/workspace-changed',
        workspace: { ...workspace('ws-created'), path: record.path, title: record.branch },
      },
    } as never)
    const { worktree: created, workspace: createdWorkspace } = await runtime.createWorktree({ repoPath: '/w/repo', name: 'slug' })
    expect(created.worktreeId).toBe('wt-new')
    expect(createdWorkspace?.workspaceId).toBe('ws-created')
    // The projection reloaded after the mutation (boot pull + this one).
    expect(api.callsOf('worktree.list')).toHaveLength(2)
  })

  it('throws WorktreeActionError when the host rejects the create', async () => {
    const { api, runtime } = await booted()
    api.onWorktreeCreate = () => Promise.resolve(err({
      code: 'worktree-git-error', message: 'git failed', details: { repoPath: '/w/repo' },
    }))
    await expect(runtime.createWorktree({ repoPath: '/w/repo' })).rejects.toThrow(WorktreeActionError)
  })

  it('writes the preference into the projection and fails structured', async () => {
    const { api, runtime } = await booted()
    await runtime.setWorktreePref('/w/repo', { mode: 'new' })
    expect(runtime.list.getSnapshot().worktrees.prefs['/w/repo']).toEqual({ mode: 'new' })
    expect(api.callsOf('worktree.setPref')).toEqual([{ repoPath: '/w/repo', pref: { mode: 'new' } }])

    api.onWorktreeSetPref = () => Promise.resolve(err({ code: 'internal', message: 'down', details: {} }))
    await expect(runtime.setWorktreePref('/w/repo', { mode: 'checkout' })).rejects.toThrow(WorktreeActionError)
  })

  it('queries live status through the wire and fails structured', async () => {
    const { api, runtime } = await booted()
    api.onWorktreeStatus = payload => Promise.resolve(ok({
      path: (payload as { path: string }).path,
      branch: 'agent/slug', head: 'abc1234', dirty: true, stashCount: 2, ahead: 1, behind: 3,
    }))
    await expect(runtime.worktreeStatus('/w/repo.worktrees/slug')).resolves.toMatchObject({
      branch: 'agent/slug', stashCount: 2, dirty: true,
    })
    api.onWorktreeStatus = () => Promise.resolve(err({ code: 'worktree-not-a-repository', message: 'gone', details: { path: '/x' } }))
    await expect(runtime.worktreeStatus('/x')).rejects.toThrow(WorktreeActionError)
  })
})

describe('startSession worktree interception', () => {
  it('materializes a fresh worktree and lands the session in its workspace under pref new', async () => {
    const record = worktree({ worktreeId: 'wt-auto', workspaceId: 'ws-wt-auto' })
    const { api, runtime } = await booted({
      prefs: { '/w/repo': { mode: 'new' } as never },
    })
    api.onWorktreeCreate = () => {
      // The host registers the worktree's workspace; its row travels the
      // workspace stream while the create call is in flight.
      runtime.handleHostEnvelope({
        rpcId: 'wt-ws-auto' as never,
        payload: {
          type: 'host/workspace-changed',
          workspace: { ...workspace('ws-wt-auto'), path: record.path, title: record.branch },
        },
      } as never)
      return Promise.resolve(ok({ worktree: record as never }))
    }
    runtime.startSession()
    await vi.waitFor(() => {
      expect(api.callsOf('session.create')).toEqual([
        expect.objectContaining({ workspaceId: 'ws-wt-auto' }),
      ])
    })
    expect(api.callsOf('worktree.create')).toEqual([{ repoPath: '/w/repo' }])
  })

  it('passes the preferred base ref to the worktree create call', async () => {
    const record = worktree({ worktreeId: 'wt-based', workspaceId: 'ws-wt-based' })
    const { api, runtime } = await booted({
      prefs: { '/w/repo': { mode: 'new', base: 'origin/develop' } as never },
    })
    api.onWorktreeCreate = () => {
      runtime.handleHostEnvelope({
        rpcId: 'wt-ws-based' as never,
        payload: {
          type: 'host/workspace-changed',
          workspace: { ...workspace('ws-wt-based'), path: record.path, title: record.branch },
        },
      } as never)
      return Promise.resolve(ok({ worktree: record as never }))
    }
    runtime.startSession()
    await vi.waitFor(() => {
      expect(api.callsOf('session.create')).toEqual([
        expect.objectContaining({ workspaceId: 'ws-wt-based' }),
      ])
    })
    expect(api.callsOf('worktree.create')).toEqual([{ repoPath: '/w/repo', base: 'origin/develop' }])
  })

  it('reattaches the preferred worktree under pref reuse and resets a stale preference', async () => {
    const { api, runtime } = await booted({
      worktreeItems: [worktree({ worktreeId: 'wt-old', workspaceId: 'ws-old' })],
      prefs: { '/w/repo': { mode: 'reuse', worktreeId: 'wt-old' } as never },
    })
    runtime.startSession()
    await vi.waitFor(() => {
      expect(api.callsOf('session.create')).toEqual([
        expect.objectContaining({ workspaceId: 'ws-old' }),
      ])
    })
    expect(api.callsOf('worktree.create')).toEqual([])

    // The preferred record is gone: the stale preference resets and the
    // checkout workspace receives the session instead.
    api.onWorktreeList = () => Promise.resolve(ok({
      items: [],
      prefs: { '/w/repo': { mode: 'reuse', worktreeId: 'wt-old' } as never },
    }))
    await runtime.refreshWorktrees()
    api.onWorktreeSetPref = () => Promise.resolve(ok({ saved: true as const }))
    runtime.startSession()
    await vi.waitFor(() => {
      expect(api.callsOf('worktree.setPref')).toEqual([{ repoPath: '/w/repo', pref: { mode: 'checkout' } }])
    })
    // The reset governs future defaults; this call still lands in the most
    // recent workspace, whose registration survives the record loss.
    await vi.waitFor(() => {
      expect(api.callsOf('session.create').at(-1)).toMatchObject({ workspaceId: 'ws-old' })
    })
  })

  it('falls back to the checkout when the worktree workspace row never lands', async () => {
    const record = worktree({ worktreeId: 'wt-slow', workspaceId: 'ws-never' })
    const { api, runtime } = await booted({
      prefs: { '/w/repo': { mode: 'new' } as never },
    })
    api.onWorktreeCreate = () => Promise.resolve(ok({ worktree: record as never }))
    runtime.startSession()
    // No frame ever carries ws-never: after the bounded wait the checkout
    // workspace receives the session (never a lost user gesture).
    await vi.waitFor(() => {
      expect(api.callsOf('session.create').at(-1)).toMatchObject({ workspaceId: 'repo' })
    }, { timeout: 3000 })
  })

  it('keeps the plain checkout flow when no preference governs the workspace', async () => {
    const { api, runtime } = await booted()
    runtime.startSession()
    await vi.waitFor(() => {
      expect(api.callsOf('session.create')).toEqual([expect.objectContaining({ workspaceId: 'repo' })])
    })
    expect(api.callsOf('worktree.create')).toEqual([])
  })
})

/** Deferred holder matching the fake's worktree.list response shape. */
function deferredWorktreeList(): {
  promise: Promise<ReturnType<typeof ok<{ items: never[]; prefs: Record<string, never> }>>>
  resolve(value: ReturnType<typeof ok<{ items: never[]; prefs: Record<string, never> }>>): void
} {
  let resolve!: (value: ReturnType<typeof ok<{ items: never[]; prefs: Record<string, never> }>>) => void
  const promise = new Promise<ReturnType<typeof ok<{ items: never[]; prefs: Record<string, never> }>>>((res) => { resolve = res })
  return { promise, resolve }
}
