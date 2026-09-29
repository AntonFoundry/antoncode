// @vitest-environment jsdom
/**
 * DagFlow canvas: the user-visible canvas behavior — node cards and edges from
 * a real board-derived graph, the legend and minimap chrome, selection and the
 * inspector, wheel zoom, drag panning, the lock, zoom/fit controls, keyboard
 * shortcuts, the empty state, and the rule that a later snapshot keeps the
 * viewport the user set.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement } from 'react'
import type { SessionId, SessionSummary, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/types'
import type { BoardSnapshot } from '../src/client/bridge.ts'
import { buildFlow } from '../src/client/flow.ts'
import { DagFlow, dagFlowLabels } from '../src/client/dagflow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const NOW = 1_000_000
const labels = dagFlowLabels(key => en[key])

const summary = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id as SessionId,
  updatedAt: NOW,
  running: false,
  blank: false,
  ...over,
})

const workspace = (workspaceId: string, sessionIds: string[]): WorkspaceView => ({
  workspaceId: workspaceId as WorkspaceView['workspaceId'],
  path: `/tmp/${workspaceId}`,
  title: workspaceId,
  sessionIds: sessionIds.map(s => s as SessionId),
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

const TODOS: TodoItem[] = [
  { content: 'ship the canvas', status: 'completed' },
  { content: 'polish handles', status: 'in_progress', children: [{ content: 'label the ports', status: 'pending' }] },
]

/** A todos projection block carrying the given nested tree. */
const todosOf = (todos: TodoItem[]): Partial<SessionSummary>['projections'] =>
  ({ asOfSeq: 1, values: { todos } })

const BOARD: BoardSnapshot = {
  items: [workspace('w', ['root'])],
  archivedSessionIds: [],
  sessions: [
    summary('root', { running: true, projections: todosOf(TODOS) }),
    summary('child', { origin: 'subagent', parentSessionId: 'root' as SessionId, running: true }),
  ],
}

/** The fixture graph: mission `root` (running) → tasks, plus a spawned agent. */
const graphOf = () => buildFlow(BOARD, { now: NOW, titles: new Map([['root', 'Root mission']]) })

const EMPTY_BOARD: BoardSnapshot = { items: [], archivedSessionIds: [], sessions: [] }

/** Stubs the layout box every element reports; jsdom itself reports zeros. */
function stubRect(width: number, height: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}),
  })
}

/** Renders the canvas over a graph with the given focus spy. */
function mount(graph = graphOf(), onFocus = vi.fn()) {
  const view = render(createElement(DagFlow, { graph, labels, onFocus }))
  const canvas = screen.getByRole('application', { name: labels.canvas })
  const plane = screen.getByRole('group', { name: labels.canvas })
  /** The plane's translate offset, parsed out of its transform. */
  const at = (): { x: number; y: number } => {
    const found = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(plane.style.transform)
    return { x: Number(found?.[1]), y: Number(found?.[2]) }
  }
  return { view, canvas, plane, at, onFocus }
}

describe('DagFlow: graph rendering', () => {
  it('renders one card per node with its kind, title, and status', () => {
    mount()
    const mission = screen.getByRole('button', { name: 'Mission Root mission' })
    expect(mission).toBeTruthy()
    expect(within(mission).getByText('Root mission')).toBeTruthy()
    expect(within(mission).getByText('running')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Agent child' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Task ship the canvas' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Task label the ports' })).toBeTruthy()
  })

  it('renders the ports as labelled handles and one path per edge', () => {
    const { view } = mount()
    const mission = screen.getByRole('button', { name: 'Mission Root mission' })
    expect(within(mission).getByText('in')).toBeTruthy()
    expect(within(mission).getByText('plan')).toBeTruthy()
    // Four edges: three plan edges plus the one task link.
    expect(view.container.querySelectorAll('path')).toHaveLength(4)
  })

  it('renders the legend for the statuses the graph actually contains', () => {
    mount()
    const legend = within(screen.getByRole('list', { name: labels.legend }))
    expect(legend.getByText('running')).toBeTruthy()
    expect(legend.getByText('in progress')).toBeTruthy()
    expect(legend.getByText('completed')).toBeTruthy()
    expect(legend.queryByText('failed')).toBeNull()
  })

  it('renders the empty state and no canvas when the board has no runs', () => {
    render(createElement(DagFlow, { graph: buildFlow(EMPTY_BOARD), labels, onFocus: vi.fn() }))
    expect(screen.getByText(labels.empty)).toBeTruthy()
    expect(screen.queryByRole('application')).toBeNull()
  })
})

describe('DagFlow: selection and inspector', () => {
  it('selects a node and inspects its kind, status, session, and steps', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Mission Root mission' }))
    const inspector = screen.getByRole('complementary', { name: 'Root mission' })
    expect(within(inspector).getByText('Mission')).toBeTruthy()
    expect(within(inspector).getByText('running')).toBeTruthy()
    expect(within(inspector).getByText('root')).toBeTruthy()
    expect(within(inspector).getByText(/ship the canvas/)).toBeTruthy()
    expect(within(inspector).getByText(/polish handles/)).toBeTruthy()
    // A mission has no path row.
    expect(within(inspector).queryByText('Path')).toBeNull()
  })

  it('shows the child-index path for a nested task', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Task label the ports' }))
    const inspector = screen.getByRole('complementary', { name: 'label the ports' })
    expect(within(inspector).getByText('1.0')).toBeTruthy()
  })

  it('closes the inspector from its close button and from Escape', () => {
    const { canvas } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Mission Root mission' }))
    fireEvent.click(screen.getByRole('button', { name: labels.close }))
    expect(screen.queryByRole('complementary')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Mission Root mission' }))
    fireEvent.keyDown(canvas, { key: 'Escape' })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('clears the selection when the background is pressed', () => {
    const { canvas } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Mission Root mission' }))
    fireEvent.mouseDown(canvas, { clientX: 5, clientY: 5 })
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('raises focus for the selected node\'s session', () => {
    const { onFocus } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Task ship the canvas' }))
    fireEvent.click(screen.getByRole('button', { name: labels.focus }))
    expect(onFocus).toHaveBeenCalledWith('root')
  })
})

describe('DagFlow: viewport', () => {
  it('zooms with the wheel, anchored at the cursor', () => {
    stubRect(2000, 1200)
    const { canvas } = mount()
    expect(screen.getByText('100%')).toBeTruthy()
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 400, clientY: 300 })
    expect(screen.getByText('116%')).toBeTruthy()
    fireEvent.wheel(canvas, { deltaY: 100, clientX: 400, clientY: 300 })
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('zooms with the controls and stops at the scale bounds', () => {
    stubRect(2000, 1200)
    mount()
    fireEvent.click(screen.getByRole('button', { name: labels.zoomIn }))
    expect(screen.getByText('120%')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: labels.zoomOut }))
    expect(screen.getByText('100%')).toBeTruthy()
    // The lower bound clamps repeated zooming out.
    for (let step = 0; step < 12; step++) fireEvent.click(screen.getByRole('button', { name: labels.zoomOut }))
    expect(screen.getByText('20%')).toBeTruthy()
  })

  it('zooms and fits from the keyboard, ignoring unrelated keys', () => {
    stubRect(2000, 1200)
    const { canvas } = mount()
    fireEvent.keyDown(canvas, { key: '+' })
    expect(screen.getByText('120%')).toBeTruthy()
    fireEvent.keyDown(canvas, { key: '=' })
    expect(screen.getByText('144%')).toBeTruthy()
    fireEvent.keyDown(canvas, { key: '_' })
    expect(screen.getByText('120%')).toBeTruthy()
    fireEvent.keyDown(canvas, { key: '-' })
    expect(screen.getByText('100%')).toBeTruthy()
    fireEvent.keyDown(canvas, { key: 'F' })
    expect(screen.getByText('100%')).toBeTruthy()
    fireEvent.keyDown(canvas, { key: '+' })
    fireEvent.keyDown(canvas, { key: '0' })
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('pans on background drag and stops on mouse up and mouse leave', () => {
    stubRect(800, 600)
    const { canvas, at } = mount()
    const start = at()
    fireEvent.mouseDown(canvas, { clientX: 400, clientY: 300 })
    fireEvent.mouseMove(canvas, { clientX: 460, clientY: 340 })
    expect(at()).toEqual({ x: start.x + 60, y: start.y + 40 })
    fireEvent.mouseUp(canvas)
    fireEvent.mouseMove(canvas, { clientX: 500, clientY: 400 })
    expect(at()).toEqual({ x: start.x + 60, y: start.y + 40 })
    fireEvent.mouseDown(canvas, { clientX: 400, clientY: 300 })
    fireEvent.mouseLeave(canvas)
    fireEvent.mouseMove(canvas, { clientX: 500, clientY: 400 })
    expect(at()).toEqual({ x: start.x + 60, y: start.y + 40 })
  })

  it('holds the view still while panning is locked', () => {
    stubRect(800, 600)
    const { canvas, at } = mount()
    fireEvent.click(screen.getByRole('button', { name: labels.lock }))
    const locked = at()
    fireEvent.mouseDown(canvas, { clientX: 400, clientY: 300 })
    fireEvent.mouseMove(canvas, { clientX: 460, clientY: 340 })
    expect(at()).toEqual(locked)
    // The control now offers the inverse action.
    fireEvent.click(screen.getByRole('button', { name: labels.unlock }))
    fireEvent.mouseDown(canvas, { clientX: 400, clientY: 300 })
    fireEvent.mouseMove(canvas, { clientX: 430, clientY: 300 })
    expect(at()).toEqual({ x: locked.x + 30, y: locked.y })
  })

  it('fits the graph into the measured canvas and recentres from the minimap', () => {
    stubRect(800, 600)
    const { at } = mount()
    const fitted = at()
    fireEvent.click(screen.getByRole('button', { name: labels.zoomIn }))
    fireEvent.click(screen.getByRole('button', { name: labels.zoomIn }))
    expect(at()).not.toEqual(fitted)
    fireEvent.click(screen.getByRole('button', { name: labels.fit }))
    expect(at()).toEqual(fitted)

    fireEvent.mouseDown(screen.getByRole('button', { name: labels.minimap }), { clientX: 40, clientY: 30 })
    expect(at()).not.toEqual(fitted)
  })

  it('leaves the view alone when the canvas has not been measured', () => {
    const { at } = mount()
    const start = at()
    fireEvent.click(screen.getByRole('button', { name: labels.zoomIn }))
    // Zooming about the unknown centre still moves the plane, and the scale follows.
    expect(at()).not.toEqual(start)
    expect(screen.getByText('120%')).toBeTruthy()
  })

  it('treats a canvas without height as unmeasured', () => {
    stubRect(800, 0)
    const { at } = mount()
    const start = at()
    // Fit cannot run, so pressing it leaves the identity view in place.
    fireEvent.click(screen.getByRole('button', { name: labels.fit }))
    expect(screen.getByText('100%')).toBeTruthy()
    expect(at()).toEqual(start)
  })

  it('keeps the viewport the user set when a later snapshot rebuilds the graph', () => {
    stubRect(800, 600)
    const { view, canvas, at } = mount()
    fireEvent.mouseDown(canvas, { clientX: 400, clientY: 300 })
    fireEvent.mouseMove(canvas, { clientX: 470, clientY: 300 })
    const panned = at()
    view.rerender(createElement(DagFlow, { graph: graphOf(), labels, onFocus: vi.fn() }))
    expect(at()).toEqual(panned)
  })
})
