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
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import {
  WM_LEAF_CONVERSATION, WM_LEAF_DETAILS, WM_LEAF_SIDEBAR,
  canClose, countLeaves, defaultTree, findLeaf, findSplit, firstLeafId, keepOnlyLeaf, killBuffer,
  SCRATCH_BUFFER_ID,
  lastLeafId, leafIds, normalizeTree, openBuffer, removeLeaf, setBuffer, setWeights, splitLeaf,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/wm.ts'
import { createLayoutStore, createScratchStore, createWmStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import { SIDEBAR_DEFAULT } from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { PanelActions, WmTreeSource } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import { WmFrame } from '@deepseek-ai/dsh-client-ui-layout/src/client/WmFrame.tsx'
import type { WmFrameProps } from '@deepseek-ai/dsh-client-ui-layout/src/client/WmFrame.tsx'
import { FilesBuffer } from '@deepseek-ai/dsh-client-ui-layout/src/client/FilesBuffer.tsx'
import { flexDiredMatch } from '@deepseek-ai/dsh-client-ui-layout/src/client/dired.ts'
import type { WmNode } from '@deepseek-ai/dsh-client-ui-layout/src/client/wm.ts'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  SessionId, SessionListState, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'

/** The legacy three-pane shape (sidebar | conversation | details) for tests
  * that exercise details flows; defaultTree no longer ships Context open. */
function shipped3(): WmNode {
  return splitLeaf(defaultTree(), WM_LEAF_CONVERSATION, 'row', WM_LEAF_DETAILS, WM_LEAF_DETAILS)
}

describe('wm tree operations', () => {
  it('defaultTree ships workspace | chat, Context closed', () => {
    const tree = defaultTree()
    expect(tree.kind).toBe('split')
    expect(leafIds(tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    if (tree.kind !== 'split') return
    expect(tree.dir).toBe('row')
    expect(tree.weights.length).toBe(tree.children.length)
    // No details leaf: a fresh load never opens with a Context split.
    expect(leafIds(tree).includes(WM_LEAF_DETAILS)).toBe(false)
  })

  it('weights are fractional', () => {
    const tree = defaultTree()
    const sum = (n: WmNode): number =>
      n.kind === 'split' ? n.weights.reduce((a, b) => a + b, 0) : 1
    expect(sum(tree)).toBeCloseTo(1)
  })

  it('removeLeaf prunes the leaf and collapses single-child splits', () => {
    const tree = shipped3()
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
    const tree = shipped3()
    const outer = removeLeaf(tree, WM_LEAF_SIDEBAR)
    expect(outer.kind).toBe('split')
    if (outer.kind !== 'split') return
    expect(outer.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('splitLeaf inserts the new buffer beside the target with equal weights', () => {
    const tree = splitLeaf(shipped3(), WM_LEAF_CONVERSATION, 'column', 'details', 'extra')
    expect(leafIds(tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, 'extra', WM_LEAF_DETAILS])
    const split = splitLeaf(tree, WM_LEAF_CONVERSATION, 'row', 'details', 'extra2')
    expect(findLeaf(split, 'extra2')).toBeDefined()
    // 'before' lands the new leaf at the anchor's edge (sidebar re-attach).
    const before = splitLeaf(defaultTree(), WM_LEAF_CONVERSATION, 'row', 'sidebar', 'sb', 'before')
    expect(leafIds(before)).toEqual([WM_LEAF_SIDEBAR, 'sb', WM_LEAF_CONVERSATION])
  })

  it('splitting an unknown leaf is a no-op', () => {
    const tree = defaultTree()
    expect(splitLeaf(tree, 'nope', 'row', 'details', 'x')).toEqual(tree)
  })

  it('setBuffer swaps the buffer shown in a leaf', () => {
    const tree = setBuffer(shipped3(), WM_LEAF_SIDEBAR, 'details')
    expect(findLeaf(tree, WM_LEAF_SIDEBAR)?.buffer).toBe('details')
    expect(countLeaves(tree, 'details')).toBe(2)
  })

  it('canClose: every window closes except the last one standing', () => {
    const tree = shipped3()
    expect(canClose(tree, WM_LEAF_SIDEBAR)).toBe(true)
    expect(canClose(tree, WM_LEAF_DETAILS)).toBe(true)
    // The conversation pane closes too when other windows remain (C-x b
    // brings it back); only the LAST window standing is guarded.
    expect(canClose(tree, WM_LEAF_CONVERSATION)).toBe(true)
    const convOnly = keepOnlyLeaf(tree, WM_LEAF_CONVERSATION)
    expect(canClose(convOnly, WM_LEAF_CONVERSATION)).toBe(false)
    expect(canClose(tree, 'absent')).toBe(false)
  })

  it('setWeights writes a split\'s weights and firstLeafId/lastLeafId walk the depth order', () => {
    const tree = shipped3()
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
    expect(leafIds(instance.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    act(() => { instance.actions.setTree(shipped3()) })
    expect(leafIds(instance.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    // The whole value persists to the declared key.
    const stored = JSON.parse(window.localStorage.getItem('dsh.layout.wm')!) as { tree: WmNode }
    expect(leafIds(stored.tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    // A fresh instance rehydrates the persisted tree.
    const second = createWmStore().create()
    expect(leafIds(second.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
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
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION])
    service.toggleSidebar()
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    expect(firstLeafId(wm.getSnapshot().tree)).toBe(WM_LEAF_SIDEBAR)
    // The wm path never forwards to the panel actions.
    expect(panels.toggleSidebar).not.toHaveBeenCalled()
  })

  it('openDetails is a no-op when open; closeDetails removes the leaf', () => {
    const { service, wm } = wired()
    // Default: Context closed. closeDetails is a no-op; openDetails pops it.
    service.closeDetails()
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    service.openDetails()
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    expect(lastLeafId(wm.getSnapshot().tree)).toBe(WM_LEAF_DETAILS)
    service.openDetails()
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    service.closeDetails()
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
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

/** Records host listing calls; resolves one level of a small fixed tree. */
const listDirectoryLog: (string | undefined)[] = []
const DIRED_TREE: Record<string, { name: string; path: string; hidden: boolean; isDirectory: boolean }[]> = {
  '/proj/wm': [
    { name: 'a', path: '/proj/wm/a', hidden: false, isDirectory: true },
    { name: 'b.txt', path: '/proj/wm/b.txt', hidden: false, isDirectory: false },
  ],
  '/proj/wm/a': [
    { name: 'inner', path: '/proj/wm/a/inner', hidden: false, isDirectory: true },
  ],
}
function listDirectoryStub(path?: string): Promise<DirectoryListing> {
  listDirectoryLog.push(path)
  const level = { path: path ?? '/home/u', home: '/home/u', crumbs: [], entries: DIRED_TREE[path ?? ''] ?? [], truncated: false }
  return Promise.resolve(level as DirectoryListing)
}
function openPathStub(path: string): Promise<void> {
  openPathLog.push(path)
  return Promise.resolve()
}
const openPathLog: string[] = []
/** Records theme loads (M-x load-theme path). */
const loadedThemes: string[] = []

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
        : { [current]: { id: current, displayTitle: 'Test', cwd: '/proj/wm', running: false, blank: selectedSessionBlank.current, updatedAt: 1 } },
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
      themeList={() => [{ id: 'anton-dark', colorScheme: 'dark' }, { id: 'paper', colorScheme: 'light' }]}
      loadTheme={(id) => { loadedThemes.push(id) }}
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
  Element.prototype.scrollIntoView = vi.fn()
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
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
})

describe('WmFrame render', () => {
  it('renders a mode line per leaf with the buffer titles and slot contents', () => {
    const { getByText, getByTestId, getAllByLabelText, queryByText, queryByTestId } = mountFrame()
    expect(getByText('Workspace')).toBeTruthy()
    expect(getByText('Chat')).toBeTruthy()
    // Context stays closed on a fresh load (the header toggle opens it).
    expect(queryByText('Context')).toBeNull()
    expect(getByTestId('sidebar-content')).toBeTruthy()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(queryByTestId('details-content')).toBeNull()
    // Every pane carries a close button (the last window standing is
    // guarded at the operation, not the button).
    expect(getAllByLabelText('Close').length).toBe(2)
  })

  it('sidebar slot receives the layout-store concession owner props + brandInFrame', () => {
    const { slotCalls } = mountFrame()
    const sidebar = slotCalls.filter(c => c.key === 'sidebar').at(-1)!
    // Viewport 1920: the untouched preference takes the 18% share (346).
    expect(sidebar.props).toEqual({ collapsed: false, width: 346, brandInFrame: true })
    expect(slotCalls.find(c => c.key === 'conversation')!.props).toEqual({})
    expect(slotCalls.map(c => c.key)).toContain('shell.overlay')
  })

  it('mode-line close removes any leaf with a remaining window behind it', () => {
    const { container, wm, queryByText } = mountFrame()
    const closeButtonOf = (buffer: string): HTMLButtonElement =>
      container.querySelector(`[data-buffer="${buffer}"] button[aria-label="Close"]`) as HTMLButtonElement
    // The conversation pane closes too: chat returns through C-x b.
    act(() => { closeButtonOf('conversation').click() })
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR])
    expect(queryByText('Chat')).toBeNull()
  })

  it('mode-line split inserts a new pane beside the target', () => {
    const { container, getAllByText, wm } = mountFrame()
    // The conversation pane's Split right clones the buffer into a second
    // window beside it (a buffer is content; windows are views).
    const convSplit = container.querySelector('[data-buffer="conversation"] button[aria-label="Split right"]') as HTMLButtonElement
    act(() => { convSplit.click() })
    expect(leafIds(wm.getSnapshot().tree)).toHaveLength(3)
    expect(getAllByText('Chat')).toHaveLength(2)
  })

  it('brand-strip toggle removes and re-attaches the sidebar leaf', () => {
    const { getByLabelText, wm } = mountFrame()
    act(() => { getByLabelText('Toggle workspace sidebar').click() })
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION])
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
    expect(tree.weights[0]).toBeCloseTo(0.2, 5)
    // +100px on the sidebar (346 at this viewport) clamps at the 420 max.
    expect(layout.getSnapshot().sidebar).toBe(420)
  })

  it('renormalizes grow beside the pinned sidebar; no sub-one-grow dead space', () => {
    // The dead-strip bug this guards: flex-grow below one distributes only
    // that fraction of the free space (the sub-one flex-factors rule), so
    // the chat's 0.8 beside the grow-0 pinned sidebar left (1 - 0.8) of the
    // split's width empty at the frame's right edge.
    const { container } = mountFrame()
    const wrappers = [...container.querySelectorAll('[class*="paneWrapper"]')] as HTMLElement[]
    // Depth order: home sidebar wrapper (pinned px), conversation wrapper.
    expect(wrappers[0]!.style.flex).toBe('0 0 346px')
    // 0.8 renormalized over the 0.8 unpinned total: exactly 1.
    expect(wrappers[1]!.style.flex).toBe('1 1 0%')
  })

  it('only the home sidebar pane is pinned; a workspace window elsewhere carries weights', () => {
    // The fill bug this guards: a window that switched to the workspace
    // buffer (here a column split after the home sidebar leaf closed) was
    // pinned to the sidebar px preference along the split's main axis —
    // 346px TALL in a vertical slot — so the buffer filled only a small
    // box of its window.
    const detached = splitLeaf(removeLeaf(defaultTree(), WM_LEAF_SIDEBAR), WM_LEAF_CONVERSATION, 'column', 'sidebar', 'sb2')
    const { container } = mountFrame(detached)
    // The pane showing the workspace buffer sizes by split weights — the
    // wrapper is its parent flex child.
    const pane = container.querySelector('[data-buffer="sidebar"]') as HTMLElement
    const wrapper = pane.parentElement as HTMLElement
    expect(wrapper.style.flex).toBe('0.5 1 0%')
    expect(wrapper.style.flex.startsWith('0 0')).toBe(false)
  })

  it('a sash on a detached workspace window rewrites weights, not the width preference', () => {
    const detached = splitLeaf(removeLeaf(defaultTree(), WM_LEAF_SIDEBAR), WM_LEAF_CONVERSATION, 'column', 'sidebar', 'sb2')
    const { container, wm, layout } = mountFrame(detached)
    // The column split's only sash bounds the detached workspace window.
    const detachedSash = container.querySelector('[class*="sash"]') as HTMLElement
    const down = new PointerEvent('pointerdown', { pointerId: 1, clientX: 900, clientY: 300, bubbles: true })
    const move = new PointerEvent('pointermove', { pointerId: 1, clientX: 900, clientY: 500, bubbles: true })
    const up = new PointerEvent('pointerup', { pointerId: 1, clientX: 900, clientY: 500, bubbles: true })
    act(() => { detachedSash.dispatchEvent(down) })
    act(() => { detachedSash.dispatchEvent(move); vi.advanceTimersByTime(20) })
    act(() => { detachedSash.dispatchEvent(up) })
    const split = findSplit(wm.getSnapshot().tree, 'wm:split:sb2')
    expect(split).toBeDefined()
    if (split === undefined) return
    // +200px of the 1080px column grows the conversation's share; the
    // sidebar width preference is untouched (it sizes only the home pane).
    expect(split.weights[0]).toBeCloseTo(0.5 + 200 / 1080, 5)
    expect(layout.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('switching between real sessions removes the details leaf', () => {
    const { rerenderFrame, wm, queryByTestId } = mountFrame()
    // Context open (via the toggle path's tree transform), then a real
    // session switch takes it back down.
    act(() => { wm.actions.setTree(shipped3()) })
    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    expect(queryByTestId('details-content')).toBeNull()
  })

  it('a blank session switch does not close details', () => {
    const { rerenderFrame, wm } = mountFrame()
    act(() => { wm.actions.setTree(shipped3()) })
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
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION])
    frameWidth = 1920
    window.innerWidth = frameWidth
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(firstLeafId(wm.getSnapshot().tree)).toBe(WM_LEAF_SIDEBAR)
  })

  it('a tree persisted without the sidebar stays closed on widen', () => {
    const noSidebar = removeLeaf(defaultTree(), WM_LEAF_SIDEBAR)
    frameWidth = 1920
    const { wm } = mountFrame(noSidebar)
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION])
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
    act(() => { panes[1]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(wm.getSnapshot().focusedLeafId).toBe(WM_LEAF_CONVERSATION)
    expect(container.querySelector('[data-buffer="conversation"]')!.hasAttribute('data-focused')).toBe(true)
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
  it('C-x 2 / C-x 3 split the focused leaf; the buffer clones into the new window', () => {
    const { wm } = mountFrame()
    act(() => { wm.actions.setFocus(WM_LEAF_CONVERSATION) })
    press('x', { ctrlKey: true })
    press('2')
    // Emacs semantics: the new window shows the SAME buffer — a buffer is
    // content, windows are views onto it; singletons clone like any other.
    const buffers = (t: WmNode): string[] => (t.kind === 'leaf' ? [t.buffer] : t.children.flatMap(buffers))
    expect(buffers(wm.getSnapshot().tree)).toEqual(['sidebar', 'conversation', 'conversation'])
    press('x', { ctrlKey: true })
    press('3')
    expect(buffers(wm.getSnapshot().tree)).toEqual(['sidebar', 'conversation', 'conversation', 'conversation'])
  })

  it('C-x 0 closes the focused leaf but never the last window standing', () => {
    const { wm } = mountFrame()
    act(() => { wm.actions.setFocus(WM_LEAF_CONVERSATION) })
    press('x', { ctrlKey: true })
    press('0')
    // The conversation pane closes with a window behind it (C-x b returns it).
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR])
    // The LAST window standing is guarded.
    press('x', { ctrlKey: true })
    press('0')
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR])
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

  it('C-x b switches the current window even to a buffer already on screen', () => {
    const { wm, getByLabelText } = mountFrame()
    act(() => { wm.actions.setFocus(WM_LEAF_SIDEBAR) })
    press('x', { ctrlKey: true })
    press('b')
    const prompt = getByLabelText('Switch buffer') as HTMLInputElement
    expect(prompt).toBeTruthy()
    // Chat is already open in its own window: Emacs C-x b still switches the
    // CURRENT window to it — a second view of the same buffer, not a focus
    // jump. Separate act blocks: the selection state must flush between the
    // two keydowns (discrete-event batching would run Enter on the stale index).
    act(() => { prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    act(() => { prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    const buffers = (t: WmNode): string[] => (t.kind === 'leaf' ? [t.buffer] : t.children.flatMap(buffers))
    // A swap, not a split: two windows, both showing Chat.
    expect(buffers(wm.getSnapshot().tree)).toEqual(['conversation', 'conversation'])
    expect(findLeaf(wm.getSnapshot().tree, wm.getSnapshot().focusedLeafId ?? '')?.buffer).toBe('conversation')
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

  it('C-n / C-p move the minibuffer selection (Emacs line motion)', () => {
    const { getByLabelText, wm } = mountFrame()
    act(() => { wm.actions.setFocus(WM_LEAF_SIDEBAR) })
    // C-n moves down one candidate: Enter then swaps this window to Chat.
    press('x', { ctrlKey: true })
    press('b')
    const prompt = getByLabelText('Switch buffer') as HTMLInputElement
    act(() => { prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true })) })
    act(() => { prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('conversation')
    // C-p from the top clamps at the first candidate: Enter swaps back.
    press('x', { ctrlKey: true })
    press('b')
    const again = getByLabelText('Switch buffer') as HTMLInputElement
    act(() => { again.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true })) })
    act(() => { again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('sidebar')
  })

  it('Escape cancels the prompt; chords fire over text fields too', () => {
    const { getByLabelText, wm } = mountFrame()
    press('x', { ctrlKey: true })
    press('b')
    expect(getByLabelText('Switch buffer')).toBeTruthy()
    press('Escape')
    expect(document.querySelector('[data-minibuffer]')).toBeNull()
    // Chords reach the parser from a TEXT-FIELD target: C-x arms (echo),
    // an unbound follower is consumed and disarms, and plain typing with
    // nothing armed neither arms nor runs anything.
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    const fromField = (key: string, mods: { ctrlKey?: boolean } = {}): void => {
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...mods })) })
    }
    fromField('x', { ctrlKey: true })
    expect(document.querySelector('[data-echo] > span')?.textContent).toBe('C-x-')
    fromField('z')
    expect(document.querySelector('[data-echo] > span')?.textContent).not.toBe('C-x-')
    fromField('1')
    fromField('2')
    // Nothing ran: the tree is untouched by bare keys with no prefix.
    expect(leafIds(wm.getSnapshot().tree)).toEqual(['sidebar', 'conversation'])
    input.remove()
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
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION])
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
    const killed = killBuffer({ buffers, tree: splitLeaf(tree, WM_LEAF_CONVERSATION, 'row', 'buffer:files:1', 'leaf-x') }, 'buffer:files:1')
    expect(killed.buffers.some(b => b.id === 'buffer:files:1')).toBe(false)
    expect(killed.buffers.some(b => b.id === 'buffer:scratch')).toBe(true)
    expect(killed.tree.kind === 'split' && leafIds(killed.tree)).toContain('leaf-x')
    const x = findLeaf(killed.tree, 'leaf-x')
    expect(x?.buffer).toBe('buffer:scratch')
  })

  it('openBuffer splits a new window beside the anchor showing the buffer', () => {
    const tree = openBuffer(defaultTree(), 'conversation', 'column', 'buffer:scratch', 'leaf-s')
    expect(leafIds(tree)).toEqual(['sidebar', 'conversation', 'leaf-s'])
    expect(findLeaf(tree, 'leaf-s')?.buffer).toBe('buffer:scratch')
  })
})

describe('winner mode + new chords (window listener)', () => {
  it('C-c ←/→ undo and redo structural layout changes', () => {
    const { wm } = mountFrame()
    act(() => { wm.actions.setFocus(WM_LEAF_CONVERSATION) })
    press('x', { ctrlKey: true })
    press('3') // split-right — pops Context: a structural change
    expect(leafIds(wm.getSnapshot().tree)).toHaveLength(3)
    press('c', { ctrlKey: true })
    press('ArrowLeft') // winner-undo
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    press('c', { ctrlKey: true })
    press('ArrowRight') // winner-redo
    expect(leafIds(wm.getSnapshot().tree)).toHaveLength(3)
    // Winner redo exhausted then undone again: no stray throws either way.
    press('c', { ctrlKey: true })
    press('ArrowLeft')
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
  })

  it('C-x C-f opens the ido prompt; typing narrows, Enter descends, C-j lands dired', async () => {
    const { container } = mountFrame(undefined, [])
    press('x', { ctrlKey: true })
    press('f', { ctrlKey: true })

    const input = () => container.querySelector('[data-ido] input') as HTMLInputElement
    expect(input()).toBeTruthy()
    // The prompt seeds at the focused session's workspace directory.
    expect(listDirectoryLog.at(-1)).toBe('/proj/wm')
    await act(async () => { await Promise.resolve() })
    // The live list shows the level: a directory and a plain file.
    expect(container.querySelectorAll('[data-ido] li').length).toBe(2)
    // Typing narrows ido-style (flex, case-insensitive)…
    await act(async () => { fireEvent.change(input(), { target: { value: 'B.TXT' } }) })
    expect(container.querySelectorAll('[data-ido] li').length).toBe(1)
    await act(async () => { fireEvent.change(input(), { target: { value: '' } }) })
    // …Enter on the selected directory descends into it.
    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }) })
    expect(listDirectoryLog.at(-1)).toBe('/proj/wm/a')
    // C-j lands the full dired window at the active directory.
    await act(async () => { fireEvent.keyDown(input(), { key: 'j', ctrlKey: true }) })
    expect(container.querySelector('[data-buffer="files"]')).toBeTruthy()
    expect(document.querySelector('[data-minibuffer][data-ido]')).toBeNull()
    // Escape cancels a reopened prompt.
    press('x', { ctrlKey: true })
    press('f', { ctrlKey: true })
    expect(container.querySelector('[data-ido] input')).toBeTruthy()
    press('Escape')
    expect(container.querySelector('[data-ido] input')).toBeNull()
  })





  it('the modifier down-stroke of a real keyboard never disarms the armed prefix', async () => {
    // C-x C-f on a real keyboard sends Control↓ AGAIN between the two
    // keystrokes. That bare modifier keydown is unbound — and used to
    // disarm the prefix mid-chord, making C-x C-f unreachable live.
    const { container } = mountFrame()
    const fromBody = (key: string, mods: { ctrlKey?: boolean } = {}): void => {
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...mods })) })
    }
    fromBody('x', { ctrlKey: true })
    expect(document.querySelector('[data-echo] > span')?.textContent).toBe('C-x-')
    fromBody('Control', { ctrlKey: true })
    expect(document.querySelector('[data-echo] > span')?.textContent).toBe('C-x-')
    fromBody('f', { ctrlKey: true })
    // The chord ran: the ido find-file prompt opened.
    expect(container.querySelector('[data-ido] input')).toBeTruthy()
  })

  it('C-x ←/→ cycle the focused leaf through the whole registry', () => {
    const { wm } = mountFrame()
    act(() => { wm.actions.setFocus(WM_LEAF_SIDEBAR) })
    press('x', { ctrlKey: true })
    // Registry order: Workspace, Chat, Context, *scratch*. Chat is shown in
    // its own window — cycling lands on it anyway (clones, not skips).
    press('ArrowRight')
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('conversation')
    press('x', { ctrlKey: true })
    press('ArrowRight')
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('details')
    press('x', { ctrlKey: true })
    press('ArrowRight')
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe(SCRATCH_BUFFER_ID)
    press('x', { ctrlKey: true })
    press('ArrowLeft') // back through the same order
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('details')
  })

  it('C-x k offers open non-singleton buffers; killing swaps to scratch', () => {
    const { wm } = mountFrame()
    act(() => {
      wm.actions.setBuffers([...wm.getSnapshot().buffers, { id: 'buffer:files:9', kind: 'files', path: '/tmp' }])
    })
    // Show the files buffer in the conversation leaf.
    const t = wm.getSnapshot().tree
    act(() => { wm.actions.setTree(setBuffer(t, WM_LEAF_CONVERSATION, 'buffer:files:9')) })
    press('x', { ctrlKey: true })
    press('k')
    const input = document.querySelector('[data-minibuffer] input') as HTMLInputElement
    expect(input).toBeTruthy()
    // Type to narrow to the files buffer, then Enter.
    typeInput(input, 'Dired')
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    // The killed buffer's leaf swapped to *scratch*; registry pruned.
    expect(wm.getSnapshot().buffers.some(b => b.id === 'buffer:files:9')).toBe(false)
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_CONVERSATION)?.buffer).toBe('buffer:scratch')
    expect(wm.getSnapshot().buffers.some(b => b.id === 'buffer:scratch')).toBe(true)
  })

  it('C-x C-s bumps the scratch flush; C-x l resets the layout', () => {
    const { wm, getByLabelText } = mountFrame()
    press('x', { ctrlKey: true })
    press('s', { ctrlKey: true }) // save — a flush tick, harmless without scratch visible
    expect(document.querySelector('[data-minibuffer]')).toBeNull()
    press('x', { ctrlKey: true })
    press('l') // reset layout
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
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

describe('weight-normalization regression (pane placement bug)', () => {

  /** Find a split by id anywhere in the tree (root included). */
  const findSplitById = (n: WmNode, id: string): WmNode | undefined => {
    if (n.kind === 'split') {
      if (n.id === id) return n
      for (const c of n.children) {
        const hit = findSplitById(c, id)
        if (hit !== undefined) return hit
      }
    }
    return undefined
  }

  /** Every split's weights must sum to 1. */
  const sumsHold = (n: WmNode): boolean =>
    n.kind === 'leaf' || (
      Math.abs(n.weights.reduce((a, b) => a + b, 0) - 1) < 1e-9
      && n.children.every(sumsHold)
    )

  it('the user sequence keeps the conversation leaf dominant with unit-weight splits', () => {
    // The reported session: default tree → close Context → close the sidebar
    // leaf → re-attach the sidebar. The conversation leaf must stay dominant
    // and every split must hold the sum-1 invariant.
    let tree = removeLeaf(defaultTree(), WM_LEAF_DETAILS)
    tree = removeLeaf(tree, WM_LEAF_SIDEBAR)
    tree = splitLeaf(tree, WM_LEAF_CONVERSATION, 'row', 'sidebar', WM_LEAF_SIDEBAR, 'before', [0.18, 0.82])
    expect(sumsHold(tree)).toBe(true)
    // The re-split carries the sidebar at its preferred share; the
    // conversation anchor keeps the dominant 0.82.
    const resplit = findSplitById(tree, `wm:split:${WM_LEAF_SIDEBAR}`)
    expect(resplit).toBeDefined()
    if (resplit?.kind !== 'split') return
    expect(resplit.weights[0]).toBeCloseTo(0.18, 9)
    expect(resplit.weights[1]).toBeCloseTo(0.82, 9)
    expect(resplit.weights[1]).toBeGreaterThan(0.5)
  })

  it('collapsing a details-dominant split gives the survivor the whole slot', () => {
    // The direct root cause: removeLeaf(details) on the default tree must NOT
    // hand the conversation the inner split's tiny 1/641 share.
    const tree = removeLeaf(defaultTree(), WM_LEAF_DETAILS)
    expect(tree.kind).toBe('split')
    if (tree.kind !== 'split') return
    expect(sumsHold(tree)).toBe(true)
    // The conversation leaf inherits the collapsed split's whole slot (0.8),
    // not its own tiny pre-collapse share — the direct root cause of the
    // dead-space bug.
    expect(tree.weights[0]).toBeCloseTo(0.2, 9)
    expect(tree.weights[1]).toBeCloseTo(0.8, 9)
  })

  it('normalizeTree rescales drifted splits, equalizes zero totals, and is reference-stable', () => {
    const drifted: WmNode = {
      kind: 'split',
      id: 's',
      dir: 'row',
      children: [
        { kind: 'leaf', id: 'a', buffer: 'sidebar' },
        { kind: 'leaf', id: 'b', buffer: 'conversation' },
      ],
      weights: [0.3, 0.3],
    }
    const fixed = normalizeTree(drifted)
    expect(fixed.kind === 'split' && fixed.weights).toEqual([0.5, 0.5])
    // Already normalized: same reference.
    const unit = defaultTree()
    expect(normalizeTree(unit)).toBe(unit)
    expect(normalizeTree(fixed)).toBe(fixed)
    // Zero total distributes equally.
    const zero: WmNode = { ...drifted, weights: [0, 0] }
    const equalized = normalizeTree(zero)
    expect(equalized.kind === 'split' && equalized.weights).toEqual([0.5, 0.5])
    // Nested splits normalize recursively.
    const nested: WmNode = { ...drifted, children: [drifted, { ...drifted, weights: [1, 1] }], weights: [1, 1] }
    expect(sumsHold(normalizeTree(nested))).toBe(true)
  })

  it('the mount heal repairs a persisted tree whose weights sum to 0.6', () => {
    const corrupted: WmNode = {
      kind: 'split',
      id: 'wm:root',
      dir: 'row',
      children: [
        { kind: 'leaf', id: WM_LEAF_SIDEBAR, buffer: 'sidebar' },
        { kind: 'leaf', id: WM_LEAF_CONVERSATION, buffer: 'conversation' },
      ],
      weights: [0.36, 0.24],
    }
    const { wm } = mountFrame(corrupted, [])
    act(() => { wm.actions.reconcile() })
    const healed = wm.getSnapshot().tree
    expect(sumsHold(healed)).toBe(true)
    expect(healed.kind === 'split' && healed.weights[0]).toBeCloseTo(0.6, 6)
    expect(healed.kind === 'split' && healed.weights[1]).toBeCloseTo(0.4, 6)
  })

  it('sidebar re-attach takes its preferred share, not half the anchor', () => {
    const tree = splitLeaf(
      removeLeaf(defaultTree(), WM_LEAF_DETAILS),
      WM_LEAF_CONVERSATION, 'row', 'sidebar', WM_LEAF_SIDEBAR, 'before',
      [0.18, 0.82],
    )
    expect(sumsHold(tree)).toBe(true)
    // The split REPLACES the anchor leaf, so the new split is the tree (or
    // nested one level, when the anchor's parent survives) — find it.
    const resplit = findSplitById(tree, `wm:split:${WM_LEAF_SIDEBAR}`)
    expect(resplit).toBeDefined()
    if (resplit?.kind !== 'split') return
    expect(resplit.weights[0]).toBeGreaterThanOrEqual(0.17)
    expect(resplit.weights[0]).toBeLessThanOrEqual(0.19)
    expect(resplit.weights[1]).toBeCloseTo(0.82, 9)
  })
})

describe('echo area (StatusLine)', () => {
  it('rests on the focused buffer, echoes the armed chord, and expires messages', () => {
    const { container, getByTestId } = mountFrame()
    const echoText = () => container.querySelector('[data-echo] > span') as HTMLElement
    // Resting face: the focused leaf's buffer (first leaf = Workspace).
    expect(echoText().textContent).toBe('(Workspace)')
    // Arming C-x echoes the chord; the which-key popup no longer repeats it.
    press('x', { ctrlKey: true })
    expect(echoText().textContent).toBe('C-x-')
    expect(echoText().dataset.armed).toBe('true')
    // Cancel leaves its own transient message ('Quit'), not the resting face.
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(echoText().textContent).toBe('Quit')
    // A command lands a transient message; it expires back to the resting face.
    press('x', { ctrlKey: true })
    press('l')
    expect(echoText().textContent).toBe('Layout reset')
    act(() => { vi.advanceTimersByTime(4100) })
    expect(echoText().textContent).toBe('(Workspace)')
    // The strip always reports the focused buffer name and window count.
    expect(getByTestId('center-content')).toBeTruthy()
    expect(container.querySelector('[data-echo]')!.textContent).toContain('2 windows')
  })

  it('split and close leave feedback in the echo area', () => {
    const { container, wm } = mountFrame()
    const echoText = () => container.querySelector('[data-echo] > span') as HTMLElement
    act(() => { (container.querySelector('[data-buffer="conversation"] button[aria-label="Split right"]') as HTMLElement).click() })
    expect(echoText().textContent).toBe('Split right')
    // Close the cloned (second) conversation window.
    const convCloses = container.querySelectorAll('[data-buffer="conversation"] button[aria-label="Close"]')
    act(() => { (convCloses[convCloses.length - 1] as HTMLElement).click() })
    expect(echoText().textContent).toBe('Closed window')
    act(() => { (container.querySelector('[data-buffer="sidebar"] button[aria-label="Close"]') as HTMLElement).click() })
    expect(echoText().textContent).toBe('Closed window')
    // The last window standing refuses with a message instead of silently
    // (its Close button is not even rendered; the chord still reaches the
    // guarded operation).
    press('x', { ctrlKey: true })
    press('0')
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION])
    expect(echoText().textContent).toBe('The last window stands')
  })
})

describe('FilesBuffer keyboard', () => {
  const diredListing = {
    path: '/h', home: '/h', crumbs: [{ name: 'h', path: '/h', hidden: false, isDirectory: true }],
    entries: [
      { name: 'a', path: '/h/a', hidden: false, isDirectory: true, mode: 0o040755, size: 96, modified: 1700000000000 },
      { name: 'b.txt', path: '/h/b.txt', hidden: false, isDirectory: false, mode: 0o100644, size: 3072, modified: 1700000000000 },
    ],
  }

  function mountDired(active = false) {
    const listDirectory = vi.fn(async () => diredListing)
    const onNavigate = vi.fn()
    const view = render(
      <FilesBuffer
        path="/h" active={active}
        listDirectory={listDirectory as never} openPath={vi.fn(async () => {})}
        onNavigate={onNavigate} onKill={vi.fn()}
      />,
    )
    const dired = view.container.firstElementChild as HTMLElement
    return { dired, onNavigate, ...view }
  }

  const flush = async () => { await act(async () => { await Promise.resolve() }) }

  it('takes the DOM focus when its window is the focused leaf', async () => {
    const { dired } = mountDired(true)
    await flush()
    expect(document.activeElement).toBe(dired)
  })

  it('C-p / C-n move the selection like the arrows', async () => {
    const { dired } = mountDired()
    await flush()
    dired.focus()
    const selectedRow = () => dired.querySelector('[data-selected]')
    expect(selectedRow()?.textContent).toContain('a')
    // The stat columns render: a perms string per row, a kind glyph per name.
    expect(dired.querySelectorAll('[class*="perms"]')[0]?.textContent).toBe('drwxr-xr-x')
    expect(dired.querySelectorAll('[class*="perms"]')[1]?.textContent).toBe('-rw-r--r--')
    expect(dired.querySelectorAll('[class*="size"]')[0]?.textContent).toBe('96')
    expect(dired.querySelectorAll('[class*="size"]')[1]?.textContent).toBe('3.0k')
    fireEvent.keyDown(dired, { key: 'n', ctrlKey: true })
    expect(selectedRow()?.textContent).toContain('b')
    fireEvent.keyDown(dired, { key: 'p', ctrlKey: true })
    expect(selectedRow()?.textContent).toContain('a')
    // Plain keys keep working beside the ctrl chords.
    fireEvent.keyDown(dired, { key: 'n' })
    expect(selectedRow()?.textContent).toContain('b')
  })
})
