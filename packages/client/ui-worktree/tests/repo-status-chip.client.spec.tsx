// @vitest-environment jsdom
/**
 * RepoStatusChip: null arms (no cwd, failing query), the worktree-name and
 * branch renders (with the stash badge), the click refresh, and the
 * running-to-idle re-query edge.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorktreeStatus } from '@deepseek-ai/dsh-api-workspace-controller/worktree-types'
import { en } from '../src/client/locales.ts'
import type { WorktreeKey } from '../src/client/locales.ts'
import { RepoStatusChip } from '../src/client/RepoStatusChip.tsx'

afterEach(cleanup)

const sid = (id: string): SessionId => id as SessionId

const t = ((key: WorktreeKey, params?: Record<string, string | number>): string => {
  const template = en[key]
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
}) as PropsLocale<'worktree'>['t']

type ChipProps = Parameters<typeof RepoStatusChip>[0]

function sessionsState(summary: { cwd?: string; running?: boolean } | undefined): SessionListState {
  return {
    ids: summary === undefined ? [] : ([sid('s1')] as never[]),
    byId: summary === undefined ? {} : { s1: { cwd: summary.cwd, running: summary.running } as never },
    current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  } as never
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

function workspacesState(byRepo: WorkspaceSnapshot['worktrees']['byRepo']): WorkspaceSnapshot {
  return {
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
    worktrees: { byRepo, prefs: {}, namesByWorkspaceId: {} },
  }
}

function props(over: {
  summary?: { cwd?: string; running?: boolean }
  status?: (path: string, signal?: AbortSignal) => Promise<WorktreeStatus>
  byRepo?: WorkspaceSnapshot['worktrees']['byRepo']
}): ChipProps {
  return {
    sessionId: sid('s1'),
    useSessions: hook(sessionsState(over.summary ?? { cwd: '/repo' })),
    useWorkspaces: hook(workspacesState(over.byRepo ?? {})),
    status: over.status ?? (async path => ({
      path, branch: 'agent/slug', head: 'abc1234', dirty: false, stashCount: 1, ahead: 0, behind: 0,
    })),
    t,
  } as unknown as ChipProps
}

const status = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  path: '/repo', branch: 'agent/slug', head: 'abc1234', dirty: false, stashCount: 0, ahead: 0, behind: 0,
  ...over,
})

describe('RepoStatusChip', () => {
  it('renders nothing without a cwd and when the query reports a non-repository', async () => {
    const noCwd = render(<RepoStatusChip {...props({ summary: {} })} />)
    await waitFor(() => { expect(noCwd.container.firstChild).toBeNull() })
    cleanup()

    const failing = render(<RepoStatusChip {...props({ status: async () => { throw new Error('not a repo') } })} />)
    await waitFor(() => { expect(failing.container.firstChild).toBeNull() })
  })

  it('shows the branch and the stash badge only when stashes exist', async () => {
    const stashed = render(<RepoStatusChip {...props({ status: async () => status({ stashCount: 2 }) })} />)
    await waitFor(() => { expect(stashed.getByText('agent/slug')).toBeTruthy() })
    expect(stashed.getByText('Stash 2')).toBeTruthy()
    expect((stashed.getByRole('button') as HTMLElement).title)
      .toBe('Repo status: agent/slug, 2 stashes')
    cleanup()

    const clean = render(<RepoStatusChip {...props({ status: async () => status({ stashCount: 0 }) })} />)
    await waitFor(() => { expect(clean.getByText('agent/slug')).toBeTruthy() })
    expect(clean.queryByText('Stash 0')).toBeNull()
  })

  it('names a session running in a registered worktree after the worktree, with the branch in the tooltip', async () => {
    const view = render(<RepoStatusChip {...props({
      summary: { cwd: '/repo.worktrees/slug' },
      status: async path => status({ path, branch: 'agent/slug' }),
      byRepo: { '/repo': [worktreeRecord] },
    })} />)
    await waitFor(() => { expect(view.getByText('slug')).toBeTruthy() })
    expect(view.queryByText('agent/slug')).toBeNull()
    expect((view.getByRole('button') as HTMLElement).title)
      .toBe('Worktree slug, branch agent/slug, 0 stashes')
  })

  it('re-queries on click', async () => {
    const statusFn = vi.fn(async path => status({ path }))
    const view = render(<RepoStatusChip {...props({ status: statusFn })} />)
    await waitFor(() => { expect(statusFn).toHaveBeenCalledTimes(1) })
    fireEvent.click(view.getByRole('button'))
    await waitFor(() => { expect(statusFn).toHaveBeenCalledTimes(2) })
  })

  it('re-queries when the session goes idle', async () => {
    const statusFn = vi.fn(async path => status({ path }))
    const state = { summary: { cwd: '/repo', running: true } }
    const view = render(<RepoStatusChip {...props({
      summary: state.summary,
      status: statusFn,
    })} />)
    await waitFor(() => { expect(statusFn).toHaveBeenCalledTimes(1) })
    // The running→false edge re-queries; the summary object swap stands in
    // for the list-mirror update.
    state.summary.running = false
    view.rerender(<RepoStatusChip {...({
      sessionId: sid('s1'),
      useSessions: hook(sessionsState({ cwd: '/repo', running: false })),
      useWorkspaces: hook(workspacesState({})),
      status: statusFn,
      t,
    } as unknown as ChipProps)} />)
    await waitFor(() => { expect(statusFn).toHaveBeenCalledTimes(2) })
    // Staying idle does not re-query again.
    view.rerender(<RepoStatusChip {...({
      sessionId: sid('s1'),
      useSessions: hook(sessionsState({ cwd: '/repo', running: false })),
      useWorkspaces: hook(workspacesState({})),
      status: statusFn,
      t,
    } as unknown as ChipProps)} />)
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(statusFn).toHaveBeenCalledTimes(2)
  })
})
