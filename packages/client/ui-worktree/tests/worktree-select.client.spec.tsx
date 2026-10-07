// @vitest-environment jsdom
/**
 * WorktreeModeSelect: null arms (no cwd, no governing repo), the three mode
 * labels including the missing-record reuse fallback, the mount refresh, and
 * every choose arm's setMode call. Components receive plain props with stub
 * hooks — no render machinery beyond the DOM assertions.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { en } from '../src/client/locales.ts'
import type { WorktreeKey } from '../src/client/locales.ts'
import { resolveRepo, WorktreeModeSelect } from '../src/client/WorktreeModeSelect.tsx'

afterEach(cleanup)

const sid = (id: string): SessionId => id as SessionId

/** Minimal English dictionary t with {param} interpolation. */
const t = ((key: WorktreeKey, params?: Record<string, string | number>): string => {
  const template = en[key]
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
}) as PropsLocale<'worktree'>['t']

type SelectProps = Parameters<typeof WorktreeModeSelect>[0]

function sessionsState(byId: SessionListState['byId']): SessionListState {
  return { ids: Object.keys(byId) as never[], byId, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined } as never
}

function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

const worktreeRecord = {
  worktreeId: 'wt-1' as never,
  repoPath: '/repo',
  path: '/repo.worktrees/slug',
  branch: 'agent/slug',
  base: 'origin/main',
  createdAt: '2026-01-02T00:00:00.000Z',
}

function workspacesState(over: {
  prefs?: WorkspaceListState['worktrees']['prefs']
  byRepo?: WorkspaceListState['worktrees']['byRepo']
} = {}): WorkspaceListState {
  return {
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
    worktrees: { byRepo: over.byRepo ?? {}, prefs: over.prefs ?? {}, namesByWorkspaceId: {} },
  }
}

function props(over: {
  sessions?: SessionListState
  workspaces?: WorkspaceListState
  setMode?: (repoPath: string, pref: { mode: 'checkout' } | { mode: 'new' } | { mode: 'reuse'; worktreeId: string }) => Promise<void>
  refresh?: () => void
} = {}): SelectProps {
  return {
    sessionId: sid('s1'),
    useSessions: hook(over.sessions ?? sessionsState({ s1: { cwd: '/repo', running: false } as never })),
    useWorkspaces: hook(over.workspaces ?? workspacesState({
      prefs: { '/repo': { mode: 'checkout' } } as never,
      byRepo: { '/repo': [worktreeRecord] },
    })),
    setMode: over.setMode ?? vi.fn(async () => {}),
    refresh: over.refresh ?? vi.fn(),
    t,
  } as unknown as SelectProps
}

describe('resolveRepo', () => {
  const prefs = {
    '/repo': { mode: 'checkout' },
    '/a/b': { mode: 'new' },
  } as never

  it('matches exact keys, child paths, the worktree sibling layout, and picks the longest', () => {
    expect(resolveRepo('/repo', prefs)).toEqual({ key: '/repo', pref: { mode: 'checkout' } })
    expect(resolveRepo('/repo/sub/dir', prefs)).toEqual({ key: '/repo', pref: { mode: 'checkout' } })
    expect(resolveRepo('/repo.worktrees/slug', prefs)).toEqual({ key: '/repo', pref: { mode: 'checkout' } })
    expect(resolveRepo('/repo2/x', prefs)).toBeUndefined()
    expect(resolveRepo('/a/b/c', prefs)).toEqual({ key: '/a/b', pref: { mode: 'new' } })
    expect(resolveRepo('/none', prefs)).toBeUndefined()
  })
})

describe('WorktreeModeSelect', () => {
  it('renders nothing without a session cwd and without a governing repository', () => {
    const noCwd = render(<WorktreeModeSelect {...props({ sessions: sessionsState({}) })} />)
    expect(noCwd.container.firstChild).toBeNull()
    cleanup()

    const foreignCwd = render(<WorktreeModeSelect {...props({
      sessions: sessionsState({ s1: { cwd: '/elsewhere', running: false } as never }),
    })} />)
    expect(foreignCwd.container.firstChild).toBeNull()
  })

  it('refreshes the projection on mount', () => {
    const refresh = vi.fn()
    render(<WorktreeModeSelect {...props({ refresh })} />)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('labels the trigger from the current mode: checkout, new, reuse, and the missing-record fallback', () => {
    const checkout = render(<WorktreeModeSelect {...props()} />)
    expect(checkout.getByText('Current checkout')).toBeTruthy()
    cleanup()

    const fresh = render(<WorktreeModeSelect {...props({
      workspaces: workspacesState({ prefs: { '/repo': { mode: 'new' } } as never }),
    })} />)
    expect(fresh.getByText('New worktree')).toBeTruthy()
    expect((fresh.getByRole('button') as HTMLElement).title)
      .toBe('Created from origin/main; untracked files (e.g. .env) stay behind')
    cleanup()

    const reused = render(<WorktreeModeSelect {...props({
      workspaces: workspacesState({
        prefs: { '/repo': { mode: 'reuse', worktreeId: 'wt-1' } } as never,
        byRepo: { '/repo': [worktreeRecord] },
      }),
    })} />)
    expect(reused.getByText('Previous worktree (agent/slug)')).toBeTruthy()
    cleanup()

    const gone = render(<WorktreeModeSelect {...props({
      workspaces: workspacesState({
        prefs: { '/repo': { mode: 'reuse', worktreeId: 'wt-gone' } } as never,
        byRepo: { '/repo': [worktreeRecord] },
      }),
    })} />)
    expect(gone.getByText('Previous worktree')).toBeTruthy()
  })

  it('offers the repo worktrees as menu entries and writes the chosen mode', async () => {
    const setMode = vi.fn(async () => {})
    const view = render(<WorktreeModeSelect {...props({ setMode })} />)
    // A pending write disables the trigger, so every choose settles before
    // the menu reopens.
    const reopen = async (): Promise<void> => {
      await waitFor(() => {
        expect((view.getByRole('button') as HTMLButtonElement).disabled).toBe(false)
      })
      fireEvent.click(view.getByRole('button'))
    }
    fireEvent.click(view.getByRole('button'))
    expect(view.getByRole('menuitem', { name: 'Current checkout' })).toBeTruthy()
    expect(view.getByRole('menuitem', { name: 'New worktree' })).toBeTruthy()
    expect(view.getByRole('menuitem', { name: 'Previous worktree (agent/slug)' })).toBeTruthy()

    fireEvent.click(view.getByRole('menuitem', { name: 'New worktree' }))
    await waitFor(() => { expect(setMode).toHaveBeenCalledWith('/repo', { mode: 'new' }) })
    await reopen()
    fireEvent.click(view.getByRole('menuitem', { name: 'Previous worktree (agent/slug)' }))
    await waitFor(() => { expect(setMode).toHaveBeenLastCalledWith('/repo', { mode: 'reuse', worktreeId: 'wt-1' }) })
    await reopen()
    fireEvent.click(view.getByRole('menuitem', { name: 'Current checkout' }))
    await waitFor(() => { expect(setMode).toHaveBeenLastCalledWith('/repo', { mode: 'checkout' }) })
  })

  it('re-enables the trigger after a settled write', async () => {
    let release: (() => void) | undefined
    const setMode = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve }) })
    const view = render(<WorktreeModeSelect {...props({ setMode })} />)
    fireEvent.click(view.getByRole('button'))
    fireEvent.click(view.getByRole('menuitem', { name: 'New worktree' }))
    expect((view.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    release?.()
    await waitFor(() => {
      expect((view.getByRole('button') as HTMLButtonElement).disabled).toBe(false)
    })
  })
})
