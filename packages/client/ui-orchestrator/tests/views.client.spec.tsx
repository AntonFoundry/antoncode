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
import { deriveRuns, type BoardSnapshot } from '../src/client/bridge.ts'
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
  slots.register({ name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' } } } as never, () => null)
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
  ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: Object.fromEntries(board.sessions.map(s => [s.id, s])) }) } })
  ctx.provide('workspaces', { list: { getSnapshot: () => board } })
  const capture = providePresentation(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, capture, kills }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.session', 'sessions', 'workspaces'])
  })

  it('registers the orchestrator view entry with locale dictionaries', async () => {
    const { capture } = await bench()
    const entries = capture.slots.entries('conversation.view')
    expect(entries.map(e => e.options)).toMatchObject([{ id: 'orchestrator', order: 5 }])
    expect(entries.map(e => e.locale)).toEqual([NS])
    expect((entries[0]?.options.label as () => string)()).toBe('Orchestrator')
    expect(capture.dictionaries).toEqual([{ namespace: NS, dictionaries: { zh, en } }])
  })

  it('derives injected runs from current Controller snapshots', async () => {
    const { capture } = await bench()
    const entry = capture.slots.entries('conversation.view')[0]!
    const face = (entry.inject as (sessionId: SessionId) => { runs: ReturnType<typeof deriveRuns> })(sid(SNAPSHOT_SESSION))
    expect(face.runs).toEqual([expect.objectContaining({ id: SNAPSHOT_SESSION, state: 'running', children: [] })])
  })

  it('kill routes through the current Session Remote', async () => {
    const { capture, kills } = await bench()
    const entry = capture.slots.entries('conversation.view')[0]!
    const face = (entry.inject as (sessionId: SessionId) => { onAct: (id: string, action: string) => void })(sid(SNAPSHOT_SESSION))
    face.onAct(SNAPSHOT_SESSION, 'kill')
    await waitFor(() => { expect(kills).toEqual([sid(SNAPSHOT_SESSION)]) })
    face.onAct(SNAPSHOT_SESSION, 'approve')
    expect(kills).toHaveLength(1)
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
      runs: deriveRuns(SNAPSHOT),
      onAct,
    } as unknown as OrchestratorViewProps
    render(createElement(OrchestratorView, props))
    expect(screen.getByText(SNAPSHOT_SESSION)).toBeTruthy()
    expect(screen.getByText('running')).toBeTruthy()
    // Only blocked cards expose action rows; the running card has none.
    expect(screen.queryByText('kill')).toBeNull()
    expect(onAct).not.toHaveBeenCalled()
  })

  it('a run with a plan renders the collapsible section; a planless run omits it', () => {
    const base = deriveRuns(SNAPSHOT)[0]
    render(createElement(OrchestratorView, {
      runs: [{ ...base, plan: [
        { content: 'ship the board', status: 'completed' as const },
        { content: 'polish cards', status: 'in_progress' as const },
      ] }],
      onAct: vi.fn(),
    } as unknown as OrchestratorViewProps))
    expect(screen.getByText('Plan 1/2')).toBeTruthy()
    expect(screen.getByText(/ship the board/)).toBeTruthy()
    expect(screen.getByText(/polish cards/)).toBeTruthy()
  })

  it('a blocked run exposes the action row and forwards clicks', () => {
    const onAct = vi.fn()
    const base = deriveRuns(SNAPSHOT)[0]
    render(createElement(OrchestratorView, {
      runs: [{ ...base, state: 'blocked' as const }],
      onAct,
    } as unknown as OrchestratorViewProps))
    fireEvent.click(screen.getByText('kill'))
    expect(onAct).toHaveBeenCalledWith(SNAPSHOT_SESSION, 'kill')
  })
})
