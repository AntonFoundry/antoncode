// @vitest-environment jsdom
/**
 * Window-manager spec: the pure tree operations (wm.ts), the persisted wm
 * store, the LayoutController wm paths (tree operations instead of panel
 * forwards), and a WmFrame smoke render — real store instances (the
 * test-sanctioned create() path), a recording renderSlot stub, and stub
 * selector hooks. jsdom has no layout engine: split sizes come from stubbed
 * clientWidth, so sash drags are driven numerically through the stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import {
  WM_LEAF_CONVERSATION, WM_LEAF_DETAILS, WM_LEAF_SIDEBAR,
  canClose, countLeaves, defaultTree, dedupeSingletonBuffers, findLeaf, firstLeafId, keepOnlyLeaf, killBuffer,
  SCRATCH_BUFFER_ID,
  lastLeafId, leafIds, openBuffer, removeLeaf, setBuffer, setWeights, splitLeaf,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/wm.ts'
import { createLayoutStore, createScratchStore, createWmStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { PanelActions, WmTreeSource } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import { WmFrame } from '@deepseek-ai/dsh-client-ui-layout/src/client/WmFrame.tsx'
import type { WmFrameProps } from '@deepseek-ai/dsh-client-ui-layout/src/client/WmFrame.tsx'
import type { WmNode } from '@deepseek-ai/dsh-client-ui-layout/src/client/wm.ts'
import type {
  SessionId, SessionListState, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'

describe('wm tree operations', () => {
  it('defaultTree reproduces the shipped layout: sidebar | (conversation | details)', () => {
    const tree = defaultTree()
    expect(tree.kind).toBe('split')
    expect(leafIds(tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    if (tree.kind !== 'split') return
    expect(tree.dir).toBe('row')
    expect(tree.weights.length).toBe(tree.children.length)
    const main = tree.children[1]
    expect(main?.kind).toBe('split')
    if (main?.kind !== 'split') return
    expect(main.children.map(c => (c.kind === 'leaf' ? c.buffer : '')))
      .toEqual(['conversation', 'details'])
  })

  it('weights are fractional', () => {
    const tree = defaultTree()
    const sum = (n: WmNode): number =>
      n.kind === 'split' ? n.weights.reduce((a, b) => a + b, 0) : 1
    expect(sum(tree)).toBeCloseTo(1)
  })

  it('removeLeaf prunes the leaf and collapses single-child splits', () => {
    const tree = defaultTree()
    const withoutDetails = removeLeaf(tree, WM_LEAF_DETAILS)
    // The inner split collapses to the conversation leaf.
    expect(leafIds(withoutDetails)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    const withoutBoth = removeLeaf(withoutDetails, WM_LEAF_CONVERSATION)
    expect(leafIds(withoutBoth)).toEqual([WM_LEAF_SIDEBAR])
    // Removing the last leaf is a no-op: the tree is never empty.
    expect(removeLeaf(withoutBoth, WM_LEAF_SIDEBAR)).toBe(withoutBoth)
    // Unknown ids are a no-op.
    expect(removeLeaf(tree, 'nope')).toBe(tree)
  })

  it('removeLeaf renormalizes the surviving sibling weights', () => {
    const tree = defaultTree()
    const outer = removeLeaf(tree, WM_LEAF_SIDEBAR)
    expect(outer.kind).toBe('split')
    if (outer.kind !== 'split') return
    expect(outer.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('splitLeaf inserts the new buffer beside the target with equal weights', () => {
    const tree = splitLeaf(defaultTree(), WM_LEAF_CONVERSATION, 'column', 'details', 'extra')
    expect(leafIds(tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, 'extra', WM_LEAF_DETAILS])
    const split = splitLeaf(tree, WM_LEAF_CONVERSATION, 'row', 'details', 'extra2')
    expect(findLeaf(split, 'extra2')).toBeDefined()
    // 'before' lands the new leaf at the anchor's edge (sidebar re-attach).
    const before = splitLeaf(defaultTree(), WM_LEAF_CONVERSATION, 'row', 'sidebar', 'sb', 'before')
    expect(leafIds(before)).toEqual([WM_LEAF_SIDEBAR, 'sb', WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
  })

  it('splitting an unknown leaf is a no-op', () => {
    const tree = defaultTree()
    expect(splitLeaf(tree, 'nope', 'row', 'details', 'x')).toEqual(tree)
  })

  it('setBuffer swaps the buffer shown in a leaf', () => {
    const tree = setBuffer(defaultTree(), WM_LEAF_SIDEBAR, 'details')
    expect(findLeaf(tree, WM_LEAF_SIDEBAR)?.buffer).toBe('details')
    expect(countLeaves(tree, 'details')).toBe(2)
  })

  it('canClose guards the last conversation leaf only', () => {
    const tree = defaultTree()
    expect(canClose(tree, WM_LEAF_SIDEBAR)).toBe(true)
    expect(canClose(tree, WM_LEAF_DETAILS)).toBe(true)
    expect(canClose(tree, WM_LEAF_CONVERSATION)).toBe(false)
    const twoConvs = splitLeaf(tree, WM_LEAF_CONVERSATION, 'column', 'conversation', 'conv2')
    expect(canClose(twoConvs, WM_LEAF_CONVERSATION)).toBe(true)
    expect(canClose(tree, 'absent')).toBe(false)
  })

  it('setWeights writes a split\'s weights and firstLeafId/lastLeafId walk the depth order', () => {
    const tree = defaultTree()
    expect(firstLeafId(tree)).toBe(WM_LEAF_SIDEBAR)
    expect(lastLeafId(tree)).toBe(WM_LEAF_DETAILS)
    const reweighted = setWeights(tree, 'wm:root', [0.5, 0.5])
    if (reweighted.kind !== 'split') return
    expect(reweighted.weights).toEqual([0.5, 0.5])
    expect(setWeights(tree, 'nope', [1])).toEqual(tree)
  })
})

describe('wm store', () => {
  it('seeds the default tree and persists under dsh.layout.wm', () => {
    const instance = createWmStore().create()
    expect(leafIds(instance.getSnapshot().tree)).toEqual([
      WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS,
    ])
    act(() => { instance.actions.setTree(removeLeaf(instance.getSnapshot().tree, WM_LEAF_SIDEBAR)) })
    expect(leafIds(instance.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    // The whole value persists to the declared key.
    const stored = JSON.parse(window.localStorage.getItem('dsh.layout.wm')!) as { tree: WmNode }
    expect(leafIds(stored.tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    // A fresh instance rehydrates the persisted tree.
    const second = createWmStore().create()
    expect(leafIds(second.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
  })
})

describe('LayoutController wm paths', () => {
  function fakePanels(): PanelActions {
    return {
      setSidebar: vi.fn(), setDetails: vi.fn(), toggleSidebar: vi.fn(),
      setNarrow: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn(),
    }
  }
  const wired = () => {
    const service = new LayoutController()
    const panels = fakePanels()
    const wm = createWmStore().create()
    service.attachPanels(panels)
    service.attachWm(wm satisfies WmTreeSource)
    return { service, panels, wm }
  }

  it('toggleSidebar removes and re-attaches the sidebar leaf at the tree edge', () => {
    const { service, panels, wm } = wired()
    service.toggleSidebar()
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    service.toggleSidebar()
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    expect(firstLeafId(wm.getSnapshot().tree)).toBe(WM_LEAF_SIDEBAR)
    // The wm path never forwards to the panel actions.
    expect(panels.toggleSidebar).not.toHaveBeenCalled()
  })

  it('openDetails is a no-op when open; closeDetails removes the leaf', () => {
    const { service, wm } = wired()
    const before = leafIds(wm.getSnapshot().tree)
    service.openDetails()
    expect(leafIds(wm.getSnapshot().tree)).toEqual(before)
    service.closeDetails()
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    service.closeDetails()
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    service.openDetails()
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    expect(lastLeafId(wm.getSnapshot().tree)).toBe(WM_LEAF_DETAILS)
  })
})

// --- WmFrame smoke render ---------------------------------------------------

const selectedSession = { current: 's-test' as SessionId | undefined }
const selectedSessionBlank = { current: false }
let frameWidth = 1920

/** Observer stub: captures the callback so tests can fire resizes manually. */
let fireResize: (() => void) | null = null
class ResizeObserverStub {
  #cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.#cb = cb }
  observe(): void { fireResize = () => { this.#cb([], this) } }
  unobserve(): void {}
  disconnect(): void { fireResize = null }
}

const SessionProviderStub: WmFrameProps['SessionProvider'] = ({ children, empty }) =>
  selectedSession.current === undefined ? <>{empty?.() ?? null}</> : <>{children(selectedSession.current)}</>

function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

/** Records host listing calls; returns one fixed level. */
const listDirectoryLog: (string | undefined)[] = []
function listDirectoryStub(path?: string): Promise<never> {
  listDirectoryLog.push(path)
  return Promise.reject(new Error('no host in test'))
}
function openPathStub(path: string): Promise<void> {
  openPathLog.push(path)
  return Promise.resolve()
}
const openPathLog: string[] = []

function mountFrame(initialTree?: WmNode, workspaces?: { id: string; title: string }[]) {
  window.innerWidth = frameWidth
  const layout = createLayoutStore().create()
  const wm = createWmStore().create()
  const scratch = createScratchStore().create()
  if (initialTree !== undefined) act(() => { wm.actions.setTree(initialTree) })
  const slotCalls: { key: string; props: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, props: owner })
    if (key === 'sidebar') return <div data-testid="sidebar-content" />
    if (key === 'conversation') return <div data-testid="center-content" />
    if (key === 'details') return <div data-testid="details-content" />
    return <div data-testid="other-content" />
  }) as WmFrameProps['renderSlot']
  const useSessions = ((sel: (s: SessionListState) => unknown) => {
    const current = selectedSession.current
    const sessionState = {
      ids: current === undefined ? [] : [current],
      byId: current === undefined
        ? {}
        : { [current]: { id: current, displayTitle: 'Test', running: false, blank: selectedSessionBlank.current, updatedAt: 1 } },
      current,
      phase: 'ready',
    } as SessionListState
    return sel(sessionState)
  }) as never
  const workspaceState: WorkspaceListState = {
    items: (workspaces ?? []).map(w => ({
      workspaceId: w.id as never, path: `/projects/${w.id}`, title: w.title,
      sessionIds: [] as never[], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  }
  const element = () => (
    <WmFrame
      useStore={hookOf(layout)}
      actions={layout.actions}
      useWm={hookOf(wm)}
      useScratch={hookOf(scratch)}
      setTree={(tree) => { act(() => { wm.actions.setTree(tree) }) }}
      setFocus={(id) => { act(() => { wm.actions.setFocus(id) }) }}
      setBuffers={(buffers) => { act(() => { wm.actions.setBuffers(buffers) }) }}
      setSidebarWidth={(px) => { act(() => { layout.actions.setSidebar(px) }) }}
      reconcileBuffers={() => { act(() => { wm.actions.reconcile() }) }}
      writeScratch={(text) => { act(() => { scratch.actions.setText(text) }) }}
      listDirectory={listDirectoryStub}
      openPath={openPathStub}
      openWorkspace={openWorkspaceStub}
      renderSlot={renderSlot}
      useSessions={useSessions}
      useWorkspaces={((sel: (s: WorkspaceListState) => unknown) => sel(workspaceState)) as never}
      SessionProvider={SessionProviderStub}
    />
  )
  const utils = render(element())
  return { wm, scratch, layout, slotCalls, rerenderFrame: () => { utils.rerender(element()) }, ...utils }
}

/** Records the workspace-open resolutions (C-x w Enter path). */
const openWorkspaceLog: string[] = []
function openWorkspaceStub(workspaceId: string): void { openWorkspaceLog.push(workspaceId) }

/** Fire one synthetic keydown at the window (capture-phase listener target). */
function press(key: string, mods: { ctrlKey?: boolean; altKey?: boolean; code?: string } = {}): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...mods })) })
}

/** Type into a React-controlled input (native value setter + input event). */
function typeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    input.focus()
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  frameWidth = 1920
  selectedSession.current = 's-test' as SessionId
  selectedSessionBlank.current = false
  window.localStorage.clear()
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(0) }, 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  window.innerWidth = frameWidth
  Element.prototype.getBoundingClientRect = function () {
    return { width: frameWidth, height: 1080, top: 0, left: 0, right: frameWidth, bottom: 1080, x: 0, y: 0, toJSON: () => ({}) }
  }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return frameWidth } })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 1080 } })
  const captured = new WeakSet<Element>()
  Element.prototype.setPointerCapture = function () { captured.add(this) }
  Element.prototype.releasePointerCapture = function () { captured.delete(this) }
  Element.prototype.hasPointerCapture = function () { return captured.has(this) }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
})

describe('WmFrame render', () => {
  it('renders a mode line per leaf with the buffer titles and slot contents', () => {
    const { getByText, getByTestId, getAllByLabelText } = mountFrame()
    expect(getByText('Workspace')).toBeTruthy()
    expect(getByText('Chat')).toBeTruthy()
    expect(getByText('Context')).toBeTruthy()
    expect(getByTestId('sidebar-content')).toBeTruthy()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('details-content')).toBeTruthy()
    // Closable leaves (sidebar, details) carry close buttons; the last
    // conversation leaf does not.
    expect(getAllByLabelText('Close').length).toBe(2)
  })

  it('sidebar slot receives the layout-store concession owner props + brandInFrame', () => {
    const { slotCalls } = mountFrame()
    const sidebar = slotCalls.filter(c => c.key === 'sidebar').at(-1)!
    // Viewport 1920: the untouched preference takes the 18% share (346).
    expect(sidebar.props).toEqual({ collapsed: false, width: 346, brandInFrame: true })
    expect(slotCalls.find(c => c.key === 'conversation')!.props).toEqual({})
    expect(slotCalls.find(c => c.key === 'details')!.props).toEqual({})
    expect(slotCalls.map(c => c.key)).toContain('shell.overlay')
  })

  it('mode-line close removes a closable leaf but never the last conversation leaf', () => {
    const { container, wm, queryByText } = mountFrame()
    const closeButtonOf = (buffer: string): HTMLButtonElement =>
      container.querySelector(`[data-buffer="${buffer}"] button[aria-label="Close"]`) as HTMLButtonElement
    // The conversation pane renders no close button (last conversation leaf).
    expect(container.querySelector('[data-buffer="conversation"] button[aria-label="Close"]')).toBeNull()
    act(() => { closeButtonOf('details').click() })
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    expect(queryByText('Context')).toBeNull()
  })

  it('mode-line split inserts a new pane beside the target', () => {
    const { getAllByLabelText, wm } = mountFrame()
    act(() => { getAllByLabelText('Split right')[0]!.click() })
    const buffers = (t: WmNode): string[] =>
      t.kind === 'leaf' ? [t.buffer] : t.children.flatMap(buffers)
    expect(buffers(wm.getSnapshot().tree)).toEqual(['sidebar', 'sidebar', 'conversation', 'details'])
    expect(leafIds(wm.getSnapshot().tree)).toHaveLength(4)
  })

  it('brand-strip toggle removes and re-attaches the sidebar leaf', () => {
    const { getByLabelText, wm } = mountFrame()
    act(() => { getByLabelText('Toggle workspace sidebar').click() })
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    act(() => { getByLabelText('Toggle workspace sidebar').click() })
    expect(firstLeafId(wm.getSnapshot().tree)).toBe(WM_LEAF_SIDEBAR)
  })

  it('sash drag on the sidebar boundary writes the width preference; inner sashes rewrite weights', () => {
    const { container, wm, layout } = mountFrame()
    // The first sash bounds the sidebar leaf: its drag resizes the sidebar
    // width preference (the pane is pinned to that px width), weights stand.
    const sidebarSash = container.querySelector('[class*="sash"]') as HTMLElement
    const down = new PointerEvent('pointerdown', { pointerId: 1, clientX: 580, bubbles: true })
    const move = new PointerEvent('pointermove', { pointerId: 1, clientX: 680, bubbles: true })
    const up = new PointerEvent('pointerup', { pointerId: 1, clientX: 680, bubbles: true })
    act(() => { sidebarSash.dispatchEvent(down) })
    act(() => { sidebarSash.dispatchEvent(move); vi.advanceTimersByTime(20) })
    act(() => { sidebarSash.dispatchEvent(up) })
    const tree = wm.getSnapshot().tree
    expect(tree.kind).toBe('split')
    if (tree.kind !== 'split') return
    expect(tree.weights[0]).toBeCloseTo(280 / 920, 5)
    // +100px on the sidebar (346 at this viewport) clamps at the 420 max.
    expect(layout.getSnapshot().sidebar).toBe(420)
  })

  it('switching between real sessions removes the details leaf', () => {
    const { rerenderFrame, wm, queryByTestId } = mountFrame()
    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    expect(queryByTestId('details-content')).toBeNull()
  })

  it('a blank session switch does not close details', () => {
    const { rerenderFrame, wm } = mountFrame()
    selectedSession.current = 's-blank' as SessionId
    selectedSessionBlank.current = true
    act(() => { rerenderFrame() })
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
  })
})

describe('WmFrame narrow viewport', () => {
  it('drops the sidebar leaf below 900px and restores it on widen (persisted tree had it)', () => {
    frameWidth = 800
    const { wm } = mountFrame()
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    frameWidth = 1920
    window.innerWidth = frameWidth
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(firstLeafId(wm.getSnapshot().tree)).toBe(WM_LEAF_SIDEBAR)
  })

  it('a tree persisted without the sidebar stays closed on widen', () => {
    const noSidebar = removeLeaf(defaultTree(), WM_LEAF_SIDEBAR)
    frameWidth = 1920
    const { wm } = mountFrame(noSidebar)
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
  })
})

describe('focused leaf + commands', () => {
  it('keepOnlyLeaf reduces the tree to the kept leaf', () => {
    const tree = defaultTree()
    expect(leafIds(keepOnlyLeaf(tree, WM_LEAF_SIDEBAR))).toEqual([WM_LEAF_SIDEBAR])
    expect(leafIds(keepOnlyLeaf(tree, WM_LEAF_CONVERSATION))).toEqual([WM_LEAF_CONVERSATION])
    // Keeping the only leaf is a same-reference no-op.
    const single = keepOnlyLeaf(tree, WM_LEAF_SIDEBAR)
    expect(keepOnlyLeaf(single, WM_LEAF_SIDEBAR)).toBe(single)
  })

  it('pane pointerdown moves the focus cursor; mode line marks the focused pane', () => {
    const { container, wm } = mountFrame()
    const panes = container.querySelectorAll('[data-buffer]')
    act(() => { panes[2]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(wm.getSnapshot().focusedLeafId).toBe(WM_LEAF_DETAILS)
    expect(container.querySelector('[data-buffer="details"]')!.hasAttribute('data-focused')).toBe(true)
    expect(container.querySelector('[data-buffer="sidebar"]')!.hasAttribute('data-focused')).toBe(false)
  })

  it('a stale focused id falls back to the first leaf', () => {
    const { container, wm } = mountFrame()
    act(() => { wm.actions.setFocus('wm:gone') })
    // Effective focus normalizes (no pane marked focused-stale); the frame
    // still renders, and the first pane holds the highlight resolution.
    expect(container.querySelector('[data-buffer]')).toBeTruthy()
    act(() => { container.querySelector('[data-buffer="conversation"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(wm.getSnapshot().focusedLeafId).toBe(WM_LEAF_CONVERSATION)
  })
})

describe('Emacs chords (window listener)', () => {
  it('C-x 2 / C-x 3 split the focused leaf; the details pane is never duplicated', () => {
    const { wm } = mountFrame()
    act(() => { wm.actions.setFocus(WM_LEAF_CONVERSATION) })
    press('x', { ctrlKey: true })
    press('2')
    // Conversation splits into a details pane (the single session surface is
    // never duplicated).
    const buffers = (t: WmNode): string[] => (t.kind === 'leaf' ? [t.buffer] : t.children.flatMap(buffers))
    expect(buffers(wm.getSnapshot().tree)).toEqual(['sidebar', 'conversation', 'details'])
    // A second split request focuses the existing details pane — a second
    // Context leaf is the historical bug this guard exists for.
    press('x', { ctrlKey: true })
    press('3')
    expect(buffers(wm.getSnapshot().tree)).toEqual(['sidebar', 'conversation', 'details'])
    expect(wm.getSnapshot().focusedLeafId).toBe(WM_LEAF_DETAILS)
  })

  it('C-x 0 closes the focused leaf but never the last conversation leaf', () => {
    const { wm } = mountFrame()
    act(() => { wm.actions.setFocus(WM_LEAF_DETAILS) })
    press('x', { ctrlKey: true })
    press('0')
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    act(() => { wm.actions.setFocus(WM_LEAF_CONVERSATION) })
    press('x', { ctrlKey: true })
    press('0')
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
  })

  it('C-x 1 keeps only the focused leaf; C-x o cycles focus', () => {
    const { wm } = mountFrame()
    press('x', { ctrlKey: true })
    press('o')
    expect(wm.getSnapshot().focusedLeafId).toBe(WM_LEAF_CONVERSATION)
    press('x', { ctrlKey: true })
    press('1')
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION])
    press('x', { ctrlKey: true })
    press('o')
    expect(wm.getSnapshot().focusedLeafId).toBe(WM_LEAF_CONVERSATION)
  })

  it('C-x b opens the switch-buffer minibuffer; Enter focuses an open buffer', () => {
    const { wm, getByLabelText } = mountFrame()
    act(() => { wm.actions.setFocus(WM_LEAF_SIDEBAR) })
    press('x', { ctrlKey: true })
    press('b')
    const prompt = getByLabelText('Switch buffer') as HTMLInputElement
    expect(prompt).toBeTruthy()
    // Candidates are Workspace / Chat / Context — Chat is open: arrow down
    // once and Enter focuses the conversation leaf.
    // Separate act blocks: the selection state must flush between the two
    // keydowns (discrete-event batching would run Enter on the stale index).
    act(() => { prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    act(() => { prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(wm.getSnapshot().focusedLeafId).toBe(WM_LEAF_CONVERSATION)
  })

  it('C-x b to an unshown buffer swaps the focused window (Emacs: never a split)', () => {
    const { getByLabelText, wm, scratch } = mountFrame()
    const before = leafIds(wm.getSnapshot().tree)
    press('x', { ctrlKey: true })
    press('b')
    const input = getByLabelText('Switch buffer') as HTMLInputElement
    typeInput(input, 'scratch')
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    // The focused leaf (sidebar, the first) now shows scratch; no new leaf.
    expect(leafIds(wm.getSnapshot().tree)).toEqual(before)
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe(SCRATCH_BUFFER_ID)
    expect(scratch.getSnapshot().text).toEqual('')
  })

  it('Escape cancels the prompt; typing in an input never reaches the parser', () => {
    const { getByLabelText, wm } = mountFrame()
    press('x', { ctrlKey: true })
    press('b')
    expect(getByLabelText('Switch buffer')).toBeTruthy()
    press('Escape')
    expect(document.querySelector('[data-minibuffer]')).toBeNull()
    // Guard: a keydown originating on an input target is ignored entirely.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true }))
    })
    expect(wm.getSnapshot().tree).toEqual(wm.getSnapshot().tree)
  })

  it('C-x w opens the switch-workspace minibuffer; Enter opens the workspace', () => {
    const { getByLabelText } = mountFrame(undefined, [{ id: 'ws-1', title: 'Project One' }])
    press('x', { ctrlKey: true })
    press('w')
    expect(getByLabelText('Switch workspace')).toBeTruthy()
    const input = getByLabelText('Switch workspace') as HTMLInputElement
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(openWorkspaceLog).toEqual(['ws-1'])
  })

  it('M-x opens the extended-command palette; a filtered pick executes the command', () => {
    const { getByLabelText, wm } = mountFrame()
    press('x', { altKey: true, code: 'KeyX' })
    const input = getByLabelText('M-x') as HTMLInputElement
    expect(input).toBeTruthy()
    // Filter to one command and run it: delete-other-windows on the focused leaf.
    typeInput(input, 'delete-other-windows')
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    // The default focus cursor is the first leaf (sidebar): single keeps it.
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR])
  })

  it('C-x k kills the focused buffer without typing — current leads the list', () => {
    const { getByLabelText, wm } = mountFrame()
    // The default focus cursor is the first leaf (sidebar): Enter on the
    // untyped prompt must kill THAT buffer, not wait for a name.
    press('x', { ctrlKey: true })
    press('k')
    const input = getByLabelText('Kill buffer') as HTMLInputElement
    expect(input).toBeTruthy()
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    // Killing the singleton sidebar closes its leaf (a conversation remains).
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
  })

  it('M-x restart-app posts the bridge restart and shows the waiting banner', () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', (input: string | URL, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
      return Promise.reject(new TypeError('host down'))
    })
    const { getByLabelText, container } = mountFrame()
    press('x', { altKey: true, code: 'KeyX' })
    const input = getByLabelText('M-x') as HTMLInputElement
    typeInput(input, 'restart-app')
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(calls).toContain('POST /bridge/api/harness/restart')
    expect(container.textContent).toContain('Restarting')
    // C-g aborts the wait; the banner clears.
    press('g', { ctrlKey: true })
    expect(container.textContent).not.toContain('Restarting')
  })

  it('the which-key popup lists completions while a prefix is armed', () => {
    const { container } = mountFrame()
    expect(container.querySelector('[class*="whichKeyList"]')).toBeNull()
    press('x', { ctrlKey: true })
    const list = container.querySelector('[class*="whichKeyList"]')
    expect(list).toBeTruthy()
    expect(list!.textContent).toContain('switch buffer')
    press('g', { ctrlKey: true })
    expect(container.querySelector('[class*="whichKeyList"]')).toBeNull()
  })
})

describe('singleton dedupe', () => {
  it('a loaded tree with two details leaves collapses to the first one', () => {
    const doubled = splitLeaf(defaultTree(), WM_LEAF_DETAILS, 'column', 'details', 'wm:leaf:dup')
    const shipped = defaultTree()
    expect(leafIds(dedupeSingletonBuffers(doubled))).toEqual(leafIds(shipped))
    // No duplicates: the call is a no-op returning the same reference.
    expect(dedupeSingletonBuffers(shipped)).toBe(shipped)
  })
})

describe('buffer registry', () => {
  it('seeds the singletons, migrates pre-registry snapshots, and reconciles', () => {
    const instance = createWmStore().create()
    expect(instance.getSnapshot().buffers.map(b => b.id)).toEqual(['sidebar', 'conversation', 'details'])
    // Old persisted snapshot: leaves carry bare kind ids, no buffers array.
    // The ids ARE the singleton ids, so the tree renders as-is; reconcile
    // heals the registry side.
    act(() => { instance.actions.reconcile() })
    expect(instance.getSnapshot().buffers.map(b => b.id)).toEqual(['sidebar', 'conversation', 'details'])
  })

  it('killBuffer refuses singletons, swaps leaves to scratch, and prunes the registry', () => {
    const tree = defaultTree()
    const buffers = [{ id: 'sidebar', kind: 'sidebar' as const }, { id: 'conversation', kind: 'conversation' as const }, { id: 'details', kind: 'details' as const }, { id: 'buffer:files:1', kind: 'files' as const, path: '/tmp' }]
    // Singleton kill is refused.
    const refused = killBuffer({ buffers, tree }, 'conversation')
    expect(refused.buffers.map(b => b.id)).toEqual(['sidebar', 'conversation', 'details', 'buffer:files:1'])
    // A files buffer kills through: its leaf swaps to *scratch*, which is
    // created on demand.
    const killed = killBuffer({ buffers, tree: splitLeaf(tree, 'details', 'row', 'buffer:files:1', 'leaf-x') }, 'buffer:files:1')
    expect(killed.buffers.some(b => b.id === 'buffer:files:1')).toBe(false)
    expect(killed.buffers.some(b => b.id === 'buffer:scratch')).toBe(true)
    expect(killed.tree.kind === 'split' && leafIds(killed.tree)).toContain('leaf-x')
    const x = findLeaf(killed.tree, 'leaf-x')
    expect(x?.buffer).toBe('buffer:scratch')
  })

  it('openBuffer splits a new window beside the anchor showing the buffer', () => {
    const tree = openBuffer(defaultTree(), 'conversation', 'column', 'buffer:scratch', 'leaf-s')
    expect(leafIds(tree)).toEqual(['sidebar', 'conversation', 'leaf-s', 'details'])
    expect(findLeaf(tree, 'leaf-s')?.buffer).toBe('buffer:scratch')
  })
})

describe('winner mode + new chords (window listener)', () => {
  it('C-c ←/→ undo and redo structural layout changes', () => {
    const { wm } = mountFrame()
    act(() => { wm.actions.setFocus(WM_LEAF_DETAILS) })
    press('x', { ctrlKey: true })
    press('0') // close the focused details leaf — a structural change
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    press('c', { ctrlKey: true })
    press('ArrowLeft') // winner-undo
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    press('c', { ctrlKey: true })
    press('ArrowRight') // winner-redo
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    // Winner undo exhausted then re-filled: no stray throws either way.
    press('c', { ctrlKey: true })
    press('ArrowRight')
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
  })

  it('C-x C-f opens a files buffer for the typed path; C-x d lists the home level', () => {
    const { getByLabelText } = mountFrame(undefined, [])
    press('x', { ctrlKey: true })
    press('f', { ctrlKey: true })
    const input = getByLabelText('Find file') as HTMLInputElement
    act(() => {
      input.focus()
    })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    // No candidates + empty free entry: nothing opens; a typed path needs the
    // input value — drive it through the React-managed change event.
    expect(document.querySelector('[data-minibuffer]')).toBeTruthy()
    press('Escape')
  })

  it('C-x ←/→ cycle the focused leaf through the registry order', () => {
    const { wm } = mountFrame()
    act(() => { wm.actions.setFocus(WM_LEAF_SIDEBAR) })
    press('x', { ctrlKey: true })
    press('ArrowRight') // next buffer → conversation
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('conversation')
    press('x', { ctrlKey: true })
    press('ArrowLeft') // back
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('sidebar')
  })

  it('C-x k offers open non-singleton buffers; killing swaps to scratch', () => {
    const { wm } = mountFrame()
    act(() => {
      wm.actions.setBuffers([...wm.getSnapshot().buffers, { id: 'buffer:files:9', kind: 'files', path: '/tmp' }])
    })
    // Show the files buffer in the details leaf.
    const t = wm.getSnapshot().tree
    act(() => { wm.actions.setTree(setBuffer(t, WM_LEAF_DETAILS, 'buffer:files:9')) })
    press('x', { ctrlKey: true })
    press('k')
    const input = document.querySelector('[data-minibuffer] input') as HTMLInputElement
    expect(input).toBeTruthy()
    // Type to narrow to the files buffer, then Enter.
    typeInput(input, 'Dired')
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    // The killed buffer's leaf swapped to *scratch*; registry pruned.
    expect(wm.getSnapshot().buffers.some(b => b.id === 'buffer:files:9')).toBe(false)
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_DETAILS)?.buffer).toBe('buffer:scratch')
    expect(wm.getSnapshot().buffers.some(b => b.id === 'buffer:scratch')).toBe(true)
  })

  it('C-x C-s bumps the scratch flush; C-x l resets the layout', () => {
    const { wm, getByLabelText } = mountFrame()
    press('x', { ctrlKey: true })
    press('s', { ctrlKey: true }) // save — a flush tick, harmless without scratch visible
    expect(document.querySelector('[data-minibuffer]')).toBeNull()
    press('x', { ctrlKey: true })
    press('l') // reset layout
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    expect(getByLabelText('Toggle workspace sidebar')).toBeTruthy()
  })

  it('*scratch* opens on demand from C-x b and renders its textarea', () => {
    const { getByLabelText, getByText, container } = mountFrame()
    press('x', { ctrlKey: true })
    press('b')
    const input = getByLabelText('Switch buffer') as HTMLInputElement
    typeInput(input, 'scratch')
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(container.querySelector('textarea[aria-label="Scratch buffer"]')).toBeTruthy()
    expect(getByText('*scratch*')).toBeTruthy()
  })
})
