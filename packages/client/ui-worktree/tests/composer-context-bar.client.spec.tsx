// @vitest-environment jsdom
/**
 * ComposerContextBar: one workspace selector — the trigger shows the
 * session's location (worktree name, or branch in the main checkout), and
 * its menu holds the next-session mode default under a heading that says
 * so; the base picker writes the merged preference with the effective-base
 * fallback (stored pref → origin/main → first candidate). The bar hides
 * without a cwd; a non-repository query keeps the selector clickable with
 * the reason heading over greyed rows.
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

const namedWorktreeRecord = {
  ...worktreeRecord,
  worktreeId: 'wt-2' as never,
  alias: 'fix-compiler-warnings',
}

function workspacesState(
  prefs: WorkspaceSnapshot['worktrees']['prefs'],
  byRepo: WorkspaceSnapshot['worktrees']['byRepo'] = {},
): WorkspaceSnapshot {
  return {
    items: [], byId: {}, recentWorkspaceId: undefined, defaultTarget: undefined, phase: 'ready',
    worktrees: { byRepo, prefs, namesByWorkspaceId: {}, baselinesReady: true },
  } as never
}

function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

const status = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  path: '/repo', branch: 'agent/slug', head: 'abc1234', dirty: false, stashCount: 0, ahead: 0, behind: 0,
  bases: ['origin/main', 'origin/develop', 'HEAD'],
  ...over,
})

function props(over: {
  summary?: { cwd?: string; running?: boolean }
  prefs?: WorkspaceSnapshot['worktrees']['prefs']
  byRepo?: WorkspaceSnapshot['worktrees']['byRepo']
  status?: (path: string, signal?: AbortSignal) => Promise<WorktreeStatus>
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

/** Open the workspace selector menu and return the open view. */
async function openSelector(view: ReturnType<typeof render>, triggerLabel: string) {
  fireEvent.click(view.getByText(triggerLabel))
  await waitFor(() => { expect(view.container.textContent).toContain('Default location for the next session in') })
  return view
}

describe('ComposerContextBar', () => {
  it('renders nothing without a cwd, and an enabled selector with the locked explanation on a non-repository query', async () => {
    const noCwd = render(<ComposerContextBar {...props({ summary: {} })} />)
    await waitFor(() => { expect(noCwd.container.firstChild).toBeNull() })
    cleanup()

    // A cwd outside any git repository keeps the cluster visible and the
    // selector clickable: the menu opens with the reason heading and greyed
    // rows; the base picker stays hidden.
    const failing = render(<ComposerContextBar {...props({ status: async () => { throw new Error('not a repo') } })} />)
    await waitFor(() => { expect(failing.container.querySelector('[data-composer-context-bar]')).toBeTruthy() })
    const trigger = failing.getByRole('button', {
      name: '"repo" is not a git repository — worktree isolation applies to git repositories',
    }) as HTMLButtonElement
    expect(trigger.disabled).toBe(false)
    expect(trigger.title).toBe('"repo" is not a git repository — worktree isolation applies to git repositories')
    fireEvent.click(trigger)
    expect(failing.container.textContent).toContain('is not a git repository')
    expect(failing.container.textContent).toContain('New worktree')
    expect(failing.container.textContent).not.toContain('From ')
  })

  it('shows the branch as the trigger, the mode menu under its heading, and the origin/main base default', async () => {
    const view = render(<ComposerContextBar {...props()} />)
    await waitFor(() => { expect(view.getByText('agent/slug')).toBeTruthy() })
    // The mode default is not a chip anymore; it lives behind the location
    // trigger, whose menu heading names what the rows decide.
    expect(view.container.textContent).not.toContain('New worktree (next session)')
    expect(view.container.textContent).toContain('From origin/main')
    await openSelector(view, 'agent/slug')
    expect(view.container.textContent).toContain('This session: agent/slug')
    expect(view.container.textContent).toContain('Default location for the next session in repo')
    // The effective default (a fresh worktree per session — no stored
    // preference) is the selected row.
    expect(view.container.textContent).toContain('Current checkout (next session)')
  })

  it('names the trigger after the worktree when the session cwd is a registered worktree', async () => {
    const view = render(<ComposerContextBar {...props({
      summary: { cwd: '/repo.worktrees/slug' },
      byRepo: { '/repo': [worktreeRecord] },
    })} />)
    await waitFor(() => { expect(view.getByText('slug')).toBeTruthy() })
    expect(view.queryByText('agent/slug')).toBeNull()
    const trigger = view.getByRole('button', { name: 'Worktree slug, branch agent/slug' }) as HTMLElement
    expect(trigger.title).toBe('Worktree slug, branch agent/slug')
  })

  it('prefers the claimed alias as the worktree display name', async () => {
    const view = render(<ComposerContextBar {...props({
      summary: { cwd: '/repo.worktrees/slug' },
      byRepo: { '/repo': [namedWorktreeRecord] },
    })} />)
    await waitFor(() => { expect(view.getByText('fix-compiler-warnings')).toBeTruthy() })
    expect(view.queryByText('slug')).toBeNull()
  })

  it('disambiguates duplicate worktree aliases with their branches', async () => {
    const second = { ...namedWorktreeRecord, worktreeId: 'wt-3' as never, branch: 'agent/fix-compiler-warnings-2' }
    const view = render(<ComposerContextBar {...props({
      prefs: {},
      byRepo: { '/repo': [namedWorktreeRecord, second] },
    })} />)
    await waitFor(() => { expect(view.getByText('agent/slug')).toBeTruthy() })
    await openSelector(view, 'agent/slug')
    expect(view.container.textContent).toContain('Worktree fix-compiler-warnings · agent/slug')
    expect(view.container.textContent).toContain('Worktree fix-compiler-warnings · agent/fix-compiler-warnings-2')
  })

  it('writes the chosen mode as the per-repository next-session default', async () => {
    const setMode = vi.fn(async () => {})
    const view = render(<ComposerContextBar {...props({ setMode })} />)
    await waitFor(() => { expect(view.getByText('agent/slug')).toBeTruthy() })
    await openSelector(view, 'agent/slug')
    fireEvent.click(view.getByText('Current checkout (next session)'))
    await waitFor(() => {
      expect(setMode).toHaveBeenCalledWith('/repo', { mode: 'checkout' })
    })
  })

  it('lists the repository worktrees as reuse rows and marks the stored preference', async () => {
    const view = render(<ComposerContextBar {...props({
      prefs: { '/repo': { mode: 'reuse', worktreeId: 'wt-1' } as never },
      byRepo: { '/repo': [worktreeRecord] },
    })} />)
    await waitFor(() => { expect(view.getByText('agent/slug')).toBeTruthy() })
    await openSelector(view, 'agent/slug')
    expect(view.container.textContent).toContain('Worktree slug')
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

  it('re-queries when the session goes idle and on opening the selector', async () => {
    const query = vi.fn(async (path: string) => status({ path }))
    const idle = render(<ComposerContextBar {...props({ summary: { cwd: '/repo', running: true }, status: query })} />)
    await waitFor(() => { expect(query).toHaveBeenCalledOnce() })
    // Running → idle edge fires the second query.
    idle.rerender(<ComposerContextBar {...props({
      summary: { cwd: '/repo', running: false },
      status: query,
    })} />)
    await waitFor(() => { expect(query.mock.calls.length).toBeGreaterThanOrEqual(2) })
    // Opening the selector re-queries as well.
    const before = query.mock.calls.length
    fireEvent.click(idle.getByText('agent/slug'))
    await waitFor(() => { expect(query.mock.calls.length).toBeGreaterThan(before) })
  })
})
