// @vitest-environment jsdom
/** Orchestrator entry, current Controller snapshots, and run-card presentation. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { apply, inject } from '../src/client/index.ts'
import type { BoardSnapshot } from '../src/client/bridge.ts'
import { OrchestratorView, type OrchestratorViewProps } from '../src/client/views.tsx'
import { NS, en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const summary = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, retainedBy: {},
  updatedAt: Date.now(), running: false, blank: false, ...over,
})
const workspace = (workspaceId: string, sessionIds: string[]): WorkspaceView => ({
  workspaceId: workspaceId as WorkspaceView['workspaceId'],
  path: `/tmp/${workspaceId}`, title: workspaceId,
  sessionIds: sessionIds.map(sid),
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
})
const SNAPSHOT_SESSION = 'session-root-1'
const SNAPSHOT: BoardSnapshot = {
  items: [workspace('w', [SNAPSHOT_SESSION])], archivedSessionIds: [],
  sessions: [summary(SNAPSHOT_SESSION, { running: true })],
}

interface Capture {
  slots: SlotRegistry
  dictionaries: Array<{ namespace: string; dictionaries: unknown }>
  localeDisposed: boolean
}
function providePresentation(ctx: Context): Capture {
  const slots = new SlotRegistry(ctx)
  slots.register({ name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' }, 'shell.overlay': { kind: 'list', scope: 'root' } } } as never, () => null)
  const capture: Capture = { slots, dictionaries: [], localeDisposed: false }
  ctx.provide('locale', {
    register(namespace: string, dictionaries: unknown) {
      capture.dictionaries.push({ namespace, dictionaries })
      return () => { capture.localeDisposed = true }
    },
    bind: () => (key: string) => (en as Record<string, string>)[key] ?? key,
  })
  return capture
}
async function bench(board: BoardSnapshot = SNAPSHOT) {
  const ctx = new Context()
  const kills: SessionId[] = []
  ctx.provide('remote', { session: { cancel: async ({ sessionId }: { sessionId: SessionId }) => {
    kills.push(sessionId)
    return { ok: true as const, value: { accepted: true as const } }
  } } })
  ctx.provide('remote.session', ctx.remote.session)
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ byId: Object.fromEntries(board.sessions.map(s => [s.id, s])) }) },
    subagentAddress: () => undefined,
    using: async (id: SessionId, _options: object, operation: (reference: object) => Promise<void>) => operation({
      binding: { session: { cancel: () => ctx.remote.session.cancel({ sessionId: id }) } },
    }),
  })
  ctx.provide('workspaces', { list: { getSnapshot: () => board } })
  const capture = providePresentation(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, capture, kills }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'sessions', 'workspaces'])
  })

  it('registers the orchestrator view entry with locale dictionaries', async () => {
    const { capture } = await bench()
    const entries = capture.slots.entries('conversation.view')
    expect(entries.map(e => e.options)).toMatchObject([{ id: 'orchestrator', order: 5 }])
    expect(entries.map(e => e.locale)).toEqual([NS])
    expect((entries[0]?.options.label as () => string)()).toBe('Orchestrator')
    expect(capture.dictionaries).toEqual([{ namespace: NS, dictionaries: { zh, en } }])
  })

  it('binds the current Controller source identities instead of injection-time values', async () => {
    const { ctx, capture } = await bench()
    const entry = capture.slots.entries('conversation.view')[0]!
    const face = (entry.inject as (sessionId: SessionId) => {
      hooks: { boardSessions: object; boardWorkspaces: object }
    })(sid(SNAPSHOT_SESSION))
    expect(face.hooks.boardSessions).toBe(ctx.sessions.list)
    expect(face.hooks.boardWorkspaces).toBe(ctx.workspaces.list)
  })

  it('kill routes through the current Session Remote', async () => {
    const { capture, kills } = await bench()
    const entry = capture.slots.entries('conversation.view')[0]!
    const face = (entry.inject as (sessionId: SessionId) => { onAct: (id: string, action: string) => void })(sid(SNAPSHOT_SESSION))
    face.onAct(SNAPSHOT_SESSION, 'kill')
    await waitFor(() => { expect(kills).toEqual([sid(SNAPSHOT_SESSION)]) })
  })

  it('reports the original structured denial without changing board data', async () => {
    const { ctx, capture, fiber } = await bench()
    const denied = { code: 'session/forbidden', message: 'This peer cannot cancel this session' }
    vi.spyOn(ctx.remote.session, 'cancel').mockResolvedValue({ ok: false, error: denied })
    const entry = capture.slots.entries('conversation.view')[0]!
    const face = (entry.inject as (sessionId: SessionId) => { onAct: (id: string, action: 'kill') => void })(sid(SNAPSHOT_SESSION))
    const overlay = capture.slots.entries('shell.overlay')[0]!
    const feedback = (overlay.inject as () => { hooks: { notice: { getSnapshot: () => { text: string } | null } } })()
    face.onAct(SNAPSHOT_SESSION, 'kill')
    await waitFor(() => { expect(feedback.hooks.notice.getSnapshot()?.text).toContain(denied.message) })
    expect(ctx.sessions.list.getSnapshot().byId[sid(SNAPSHOT_SESSION)]?.running).toBe(true)
    await fiber.dispose()
    expect(capture.slots.entries('shell.overlay')).toHaveLength(0)
  })

  it('fiber disposal removes the entry and the locale dictionary', async () => {
    const { fiber, capture } = await bench()
    await fiber.dispose()
    expect(capture.slots.entries('conversation.view')).toHaveLength(0)
    expect(capture.localeDisposed).toBe(true)
  })
})

describe('OrchestratorView', () => {
  it('renders one card per placed run family and fires card actions', async () => {
    const onAct = vi.fn()
    const props = {
      useBoardSessions: () => ({ byId: Object.fromEntries(SNAPSHOT.sessions.map(row => [row.id, row])) }),
      useBoardWorkspaces: () => SNAPSHOT,
      onAct,
    } as OrchestratorViewProps
    render(createElement(OrchestratorView, props))
    expect(screen.getByText(SNAPSHOT_SESSION)).toBeTruthy()
    expect(screen.getByText('running')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'kill' })).toBeTruthy()
    for (const action of ['approve', 'retry', 'inject note', 'focus']) expect(screen.queryByRole('button', { name: action })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'kill' }))
    expect(onAct).toHaveBeenCalledWith(SNAPSHOT_SESSION, 'kill')
    expect(document.body.textContent).toMatchInlineSnapshot('"NEEDS YOURUNNINGsession-root-1custom · reasoning · interactiverunningkillDONE"')
  })

  it('renders updated title, running status, plan, archive and workspace placement from hook values', () => {
    let sessions = SNAPSHOT.sessions
    let projectionsBySession = {}
    let workspaces = SNAPSHOT.items
    let archivedSessionIds: SessionId[] = []
    const props = {
      useBoardSessions: () => ({ byId: Object.fromEntries(sessions.map(row => [row.id, row])), projectionsBySession }),
      useBoardWorkspaces: () => ({ items: workspaces, archivedSessionIds }),
      onAct: vi.fn(),
    } as OrchestratorViewProps
    const view = render(createElement(OrchestratorView, props))
    sessions = [summary(SNAPSHOT_SESSION, { displayTitle: 'Ship the board', running: false })]
    projectionsBySession = { [SNAPSHOT_SESSION]: { values: { todos: [{ content: 'Wire reactive sources', status: 'in_progress' }] }, state: 'ready', error: null } }
    view.rerender(createElement(OrchestratorView, props))
    expect(screen.getByText('Ship the board')).toBeTruthy()
    expect(screen.getByText('queued')).toBeTruthy()
    expect(screen.getByText(/Wire reactive sources/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'kill' })).toBeNull()
    archivedSessionIds = [sid(SNAPSHOT_SESSION)]
    view.rerender(createElement(OrchestratorView, props))
    expect(screen.queryByText('Ship the board')).toBeNull()
    archivedSessionIds = []
    workspaces = []
    view.rerender(createElement(OrchestratorView, props))
    expect(screen.queryByText('Ship the board')).toBeNull()
  })
})
