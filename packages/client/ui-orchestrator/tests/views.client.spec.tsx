// @vitest-environment jsdom
/**
 * Plugin registration acceptance on the real SlotRegistry: both conversation
 * view entries land with the right ids/order and locale dictionaries, the
 * board RPC fills the injected runs (running flag wins), kill routes to
 * orchestrator.act and refreshes, rendering a run card works, and fiber
 * disposal removes the tabs (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionSummary, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { deriveRuns, type BoardSnapshot } from '../src/client/bridge.ts'
import { OrchestratorView, type OrchestratorViewProps } from '../src/client/views.tsx'
import { NS, en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

type BoardResult =
  | { ok: true; value: BoardSnapshot }
  | { ok: false; error: { code: string; message: string; details: object } }
type BoardFn = (payload: object, signal?: AbortSignal) => Promise<{ result: BoardResult }>
type ActFn = (payload: { sessionId: string; action: 'kill' }, signal?: AbortSignal) => Promise<{ result: { ok: true; value: { accepted: true } } }>

const sid = (id: string) => id as SessionId

const summary = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: sid(id),
  updatedAt: 1_000_000,
  running: false,
  blank: false,
  ...over,
})

const workspace = (workspaceId: string, sessionIds: string[]): WorkspaceView => ({
  workspaceId: workspaceId as WorkspaceView['workspaceId'],
  path: `/tmp/${workspaceId}`,
  title: workspaceId,
  sessionIds: sessionIds.map(sid),
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

interface Capture {
  slots: SlotRegistry
  dictionaries: Array<{ namespace: string; dictionaries: unknown }>
  localeDisposed: boolean
}

/** Provide the presentation registries and stub the locale service. */
function providePresentation(ctx: Context): Capture {
  const slots = new SlotRegistry(ctx)
  slots.register({
    name: 'root',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
  } as never, () => null)
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

/** Boot the plugin over a fake connection; returns the capture and recorded RPC traffic. */
async function bench(
  board: BoardFn,
  act: ActFn = () => Promise.resolve({ result: { ok: true as const, value: { accepted: true as const } } }),
) {
  const ctx = new Context()
  const calls: { boards: number; kills: Array<{ sessionId: string; action: 'kill' }> } = { boards: 0, kills: [] }
  ctx.provide('connection', {
    api: {
      orchestrator: {
        board: (payload: object, signal?: AbortSignal) => { calls.boards++; return board(payload, signal) },
        act: (payload: { sessionId: string; action: 'kill' }) => { calls.kills.push(payload); return act(payload) },
      },
    },
  })
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ byId: { [SNAPSHOT_SESSION]: { displayTitle: 'Root mission' } } }) },
  })
  const capture = providePresentation(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, capture, calls }
}

/** The one session id the bench's snapshots and sessions stub share. */
const SNAPSHOT_SESSION = 'session-root-1'

const boardOk = (value: BoardSnapshot): BoardFn => () => Promise.resolve({ result: { ok: true as const, value } })

const SNAPSHOT: BoardSnapshot = {
  items: [workspace('w', [SNAPSHOT_SESSION])],
  archivedSessionIds: [],
  sessions: [summary(SNAPSHOT_SESSION, { running: true })],
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'sessions'])
  })

  it('registers the orchestrator view entry with locale dictionaries and pulls the board once', async () => {
    vi.useFakeTimers()
    try {
      const { capture, calls } = await bench(boardOk(SNAPSHOT))
      const entries = capture.slots.entries('conversation.view')
      expect(entries.map(e => e.options)).toMatchObject([
        { id: 'orchestrator', order: 5 },
      ])
      expect(entries.map(e => e.locale)).toEqual([NS])
      expect((entries[0]?.options.label as () => string)()).toBe('Orchestrator')
      expect(capture.dictionaries).toEqual([{ namespace: NS, dictionaries: { zh, en } }])
      // Refresh-on-inject pull plus the interval poll (one tick under fake timers).
      expect(calls.boards).toBe(1)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(calls.boards).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('injected runs come from the latest board snapshot with running first-class', async () => {
    const { capture } = await bench(boardOk(SNAPSHOT))
    const entry = capture.slots.entries('conversation.view')[0]
    const face = (entry.inject as (sessionId: SessionId) => { runs: ReturnType<typeof deriveRuns> })(sid(SNAPSHOT_SESSION))
    expect(face.runs).toEqual([expect.objectContaining({ id: SNAPSHOT_SESSION, state: 'running', children: [] })])
  })

  it('an RPC failure keeps the last good snapshot until a poll succeeds', async () => {
    vi.useFakeTimers()
    try {
      let fail = true
      const { capture } = await bench(() => fail
        ? Promise.resolve({ result: { ok: false as const, error: { code: 'internal', message: 'boom', details: {} } } })
        : boardOk(SNAPSHOT)({}))
      const inject = capture.slots.entries('conversation.view')[0].inject as (sessionId: SessionId) => { runs: unknown[] }
      expect(inject(sid(SNAPSHOT_SESSION)).runs).toEqual([])
      fail = false
      await vi.advanceTimersByTimeAsync(15_000)
      expect(inject(sid(SNAPSHOT_SESSION)).runs).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('kill routes to orchestrator.act and refreshes the board', async () => {
    const { capture, calls } = await bench(boardOk(SNAPSHOT))
    const inject = capture.slots.entries('conversation.view')[0].inject as (sessionId: SessionId) => {
      runs: unknown[]
      onAct: (id: string, action: string) => void
    }
    const face = inject(sid(SNAPSHOT_SESSION))
    face.onAct(SNAPSHOT_SESSION, 'kill')
    await waitFor(() =>{  expect(calls.kills).toEqual([{ sessionId: SNAPSHOT_SESSION, action: 'kill' }]) })
    await waitFor(() =>{  expect(calls.boards).toBeGreaterThanOrEqual(2) })
    // Placeholder actions stay client-side.
    face.onAct(SNAPSHOT_SESSION, 'approve')
    expect(calls.kills).toHaveLength(1)
  })

  it('fiber disposal removes the entry and the locale dictionary (HMR safety)', async () => {
    const { fiber, capture } = await bench(boardOk(SNAPSHOT))
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
