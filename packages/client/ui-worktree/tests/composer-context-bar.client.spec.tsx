// @vitest-environment jsdom
/**
 * ComposerContextBar: the branch chip + mode select + base picker render for
 * a repository cwd, the base picker writes the merged preference, the
 * effective base defaults through stored pref → origin/main → first
 * candidate, and the bar hides without a cwd or on a non-repository query.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SessionListState, WorktreeStatusView, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { en } from '../src/client/locales.ts'
import type { WorktreeKey } from '../src/client/locales.ts'
import { ComposerContextBar } from '../src/client/ComposerContextBar.tsx'

afterEach(cleanup)

const sid = (id: string): SessionId => id as SessionId

const t = ((key: WorktreeKey, params?: Record<string, string | number>): string => {
  const template = en[key]
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
}) as PropsLocale<'worktree'>['t']

type BarProps = Parameters<typeof ComposerContextBar>[0]

function sessionsState(summary: { cwd?: string; running?: boolean } | undefined): SessionListState {
  return {
    ids: summary === undefined ? [] : ([sid('s1')] as never[]),
    byId: summary === undefined ? {} : { s1: { cwd: summary.cwd, running: summary.running } as never },
    current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  } as never
}

const worktreeRecord = {
  worktreeId: 'wt-1' as never,
  repoPath: '/repo',
  path: '/repo.worktrees/slug',
  branch: 'agent/slug',
  base: 'origin/main',
  createdAt: '2026-01-02T00:00:00.000Z',
}

function workspacesState(
  prefs: WorkspaceListState['worktrees']['prefs'],
  byRepo: WorkspaceListState['worktrees']['byRepo'] = {},
): WorkspaceListState {
  return {
    items: [], byId: {}, recentWorkspaceId: undefined, defaultTarget: undefined, phase: 'ready',
    worktrees: { byRepo, prefs, namesByWorkspaceId: {}, baselinesReady: true },
  } as never
}

function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

const status = (over: Partial<WorktreeStatusView> = {}): WorktreeStatusView => ({
  path: '/repo', branch: 'agent/slug', head: 'abc1234', dirty: false, stashCount: 0, ahead: 0, behind: 0,
  bases: ['origin/main', 'origin/develop', 'HEAD'],
  ...over,
})

function props(over: {
  summary?: { cwd?: string; running?: boolean }
  prefs?: WorkspaceListState['worktrees']['prefs']
  byRepo?: WorkspaceListState['worktrees']['byRepo']
  status?: (path: string, signal?: AbortSignal) => Promise<WorktreeStatusView>
  setMode?: (repoPath: string, pref: { mode: string; base?: string; worktreeId?: string }) => Promise<void>
} = {}): BarProps {
  return {
    sessionId: sid('s1'),
    useSessions: hook(sessionsState(over.summary ?? { cwd: '/repo' })),
    useWorkspaces: hook(workspacesState(over.prefs ?? {}, over.byRepo)),
    setMode: over.setMode ?? (async () => {}),
    refresh: () => {},
    status: over.status ?? (async path => status({ path })),
    t,
  } as unknown as BarProps
}

describe('ComposerContextBar', () => {
  it('renders nothing without a cwd, and an enabled trigger with the locked explanation on a non-repository query', async () => {
    const noCwd = render(<ComposerContextBar {...props({ summary: {} })} />)
    await waitFor(() => { expect(noCwd.container.firstChild).toBeNull() })
    cleanup()

    // A cwd outside any git repository keeps the cluster visible and the
    // trigger clickable: the menu opens with the reason heading and greyed
    // rows; chip and picker stay hidden.
    const failing = render(<ComposerContextBar {...props({ status: async () => { throw new Error('not a repo') } })} />)
    await waitFor(() => { expect(failing.container.querySelector('[data-composer-context-bar]')).toBeTruthy() })
    const trigger = failing.getByLabelText('Workspace mode, current: Current checkout') as HTMLButtonElement
    expect(trigger.disabled).toBe(false)
    expect(trigger.title).toBe('"repo" is not a git repository — worktree isolation applies to git repositories')
    fireEvent.click(trigger)
    expect(failing.container.textContent).toContain('is not a git repository')
    expect(failing.container.textContent).toContain('New worktree')
    expect(failing.container.textContent).not.toContain('From ')
    expect(failing.container.textContent).not.toContain('agent/slug')
  })

  it('shows the branch, the mode select, and the origin/main base default', async () => {
    const view = render(<ComposerContextBar {...props()} />)
    await waitFor(() => { expect(view.getByText('agent/slug')).toBeTruthy() })
    // The mode select rides the bar with the effective default label (a fresh
    // worktree per session — no stored preference), and the base picker
    // reflects the origin/main fallback.
    expect(view.container.textContent).toContain('New worktree')
    expect(view.container.textContent).toContain('From origin/main')
  })

  it('names the chip after the worktree when the session cwd is a registered worktree', async () => {
    const view = render(<ComposerContextBar {...props({
      summary: { cwd: '/repo.worktrees/slug' },
      byRepo: { '/repo': [worktreeRecord] },
    })} />)
    await waitFor(() => { expect(view.getByText('slug')).toBeTruthy() })
    expect(view.queryByText('agent/slug')).toBeNull()
    expect((view.getByRole('button', { name: 'Worktree slug, branch agent/slug' }) as HTMLElement).title)
      .toBe('Worktree slug, branch agent/slug')
  })

  it('prefers the stored base over the origin/main fallback', async () => {
    const view = render(<ComposerContextBar {...props({
      prefs: { '/repo': { mode: 'new', base: 'origin/develop' } as never },
    })} />)
    await waitFor(() => { expect(view.container.textContent).toContain('From origin/develop') })
  })

  it('falls back to HEAD when the status carries no candidates', async () => {
    const view = render(<ComposerContextBar {...props({
      status: async path => status({ path, bases: [] }),
    })} />)
    await waitFor(() => { expect(view.container.textContent).toContain('From HEAD') })
  })

  it('falls back to the first candidate when origin/main is absent', async () => {
    const view = render(<ComposerContextBar {...props({
      status: async path => status({ path, bases: ['upstream/trunk', 'HEAD'] }),
    })} />)
    await waitFor(() => { expect(view.container.textContent).toContain('From upstream/trunk') })
  })

  it('writes the merged preference when a base is chosen', async () => {
    const setMode = vi.fn(async () => {})
    const view = render(<ComposerContextBar {...props({
      prefs: { '/repo': { mode: 'new' } as never },
      setMode,
    })} />)
    await waitFor(() => { expect(view.getByText('From origin/main')).toBeTruthy() })
    fireEvent.click(view.getByLabelText('Base branch for new worktrees, current: origin/main'))
    fireEvent.click(view.getByText('origin/develop'))
    await waitFor(() => {
      expect(setMode).toHaveBeenCalledWith('/repo', { mode: 'new', base: 'origin/develop' })
    })
  })

  it('keeps the effective default mode when a base is chosen with no stored preference', async () => {
    const setMode = vi.fn(async () => {})
    const view = render(<ComposerContextBar {...props({ setMode })} />)
    await waitFor(() => { expect(view.getByText('From origin/main')).toBeTruthy() })
    fireEvent.click(view.getByLabelText('Base branch for new worktrees, current: origin/main'))
    fireEvent.click(view.getByText('origin/develop'))
    await waitFor(() => {
      // Storing a base alone never downgrades the effective fresh-worktree
      // default to an explicit checkout.
      expect(setMode).toHaveBeenCalledWith('/repo', { mode: 'new', base: 'origin/develop' })
    })
  })

  it('swallows a rejected base write', async () => {
    const setMode = vi.fn(async () => { throw new Error('wire down') })
    const view = render(<ComposerContextBar {...props({ setMode })} />)
    await waitFor(() => { expect(view.getByText('From origin/main')).toBeTruthy() })
    fireEvent.click(view.getByLabelText('Base branch for new worktrees, current: origin/main'))
    fireEvent.click(view.getByText('origin/develop'))
    await waitFor(() => { expect(setMode).toHaveBeenCalledOnce() })
  })

  it('re-queries when the session goes idle and on a branch-chip click', async () => {
    const query = vi.fn(async (path: string) => status({ path }))
    const idle = render(<ComposerContextBar {...props({ summary: { cwd: '/repo', running: true }, status: query })} />)
    await waitFor(() => { expect(query).toHaveBeenCalledOnce() })
    // Running → idle edge fires the second query.
    idle.rerender(<ComposerContextBar {...props({
      summary: { cwd: '/repo', running: false },
      status: query,
    })} />)
    await waitFor(() => { expect(query.mock.calls.length).toBeGreaterThanOrEqual(2) })
    // The branch chip click re-queries as well.
    const before = query.mock.calls.length
    fireEvent.click(idle.getByText('agent/slug'))
    await waitFor(() => { expect(query.mock.calls.length).toBeGreaterThan(before) })
  })
})
