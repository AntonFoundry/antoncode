/**
 * LayoutController behavior: the cross-plugin panel-action face. Geometry
 * lives in the entry store (layout-store.spec.ts) — here we assert the
 * delegation contract: attachPanels wiring, the panel actions forwarding, the
 * unwired fail-loud, re-attach overwriting a stale action set, and the
 * inline file opener (openFile) against a fake wm store.
 */
import { describe, expect, it, vi } from 'vitest'
import { LayoutController, type WmTreeSource } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { PanelActions } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import { findLeaf, type WmBuffer, type WmNode } from '@deepseek-ai/dsh-client-ui-layout/src/client/wm.ts'

function fakePanels(): PanelActions {
  return {
    setSidebar: vi.fn(),
    setDetails: vi.fn(),
    toggleSidebar: vi.fn(),
    setNarrow: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
    setMode: vi.fn(),
    toggleTabbing: vi.fn(),
    selectPanel: vi.fn(),
    retainMainPanels: vi.fn(),
    openRightbar: vi.fn(),
    closeRightbar: vi.fn(),
  }
}

/** A mutable in-memory wm store fake: snapshots read the same object. */
function fakeWm(): WmTreeSource & {
  state: { tree: WmNode; buffers: WmBuffer[]; focusedLeafId: string | undefined; sidebarBootDropped?: boolean }
} {
  const state: { tree: WmNode; buffers: WmBuffer[]; focusedLeafId: string | undefined; sidebarBootDropped?: boolean } = {
    tree: { kind: 'leaf', id: 'conversation', buffer: 'buffer:session' },
    buffers: [{ id: 'buffer:session', kind: 'session' }],
    focusedLeafId: 'conversation',
  }
  return {
    state,
    getSnapshot: () => state,
    subscribe: () => () => {},
    actions: {
      setTree: (tree) => { state.tree = tree },
      setBuffers: (buffers) => { state.buffers = [...buffers] },
      setFocus: (leafId) => { state.focusedLeafId = leafId },
      setSidebarBootDropped: (closed) => { state.sidebarBootDropped = closed },
    },
  }
}

describe('LayoutController', () => {
  it('forwards the three panel actions to the attached set', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)

    service.toggleSidebar()
    service.openDetails()
    service.closeDetails()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.openDetails).toHaveBeenCalledTimes(1)
    expect(panels.closeDetails).toHaveBeenCalledTimes(1)
    expect(panels.setSidebar).not.toHaveBeenCalled()
    expect(panels.setDetails).not.toHaveBeenCalled()
  })

  it('fails loud before the root entry wired its actions', () => {
    const service = new LayoutController()
    expect(() => { service.toggleSidebar() }).toThrow(/panel actions not wired/)
    expect(() => { service.openDetails() }).toThrow(/panel actions not wired/)
    expect(() => { service.closeDetails() }).toThrow(/panel actions not wired/)
  })

  it('re-attach overwrites the stale action set (entry re-register)', () => {
    const service = new LayoutController()
    const stale = fakePanels()
    const fresh = fakePanels()
    service.attachPanels(stale)
    service.attachPanels(fresh)

    service.toggleSidebar()

    expect(stale.toggleSidebar).not.toHaveBeenCalled()
    expect(fresh.toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('openFile splits the focused leaf into a file buffer and reports handled', () => {
    const service = new LayoutController()
    const wm = fakeWm()
    service.attachWm(wm)

    expect(service.openFile('plans/implementation_plan.md')).toBe(true)
    const bufferId = 'buffer:file:plans/implementation_plan.md'
    const leafId = `leaf:${bufferId}`
    expect(wm.state.buffers).toContainEqual({ id: bufferId, kind: 'file', path: 'plans/implementation_plan.md' })
    expect(findLeaf(wm.state.tree, leafId)).toEqual({ kind: 'leaf', id: leafId, buffer: bufferId })
    expect(wm.state.focusedLeafId).toBe(leafId)
  })

  it('openFile anchors on the first leaf when nothing is focused', () => {
    const service = new LayoutController()
    const wm = fakeWm()
    wm.state.focusedLeafId = undefined
    service.attachWm(wm)

    expect(service.openFile('notes.md')).toBe(true)
    expect(wm.state.focusedLeafId).toBe('leaf:buffer:file:notes.md')
  })

  it('openFile reports unhandled for OS-open families without writing the wm', () => {
    const service = new LayoutController()
    const wm = fakeWm()
    service.attachWm(wm)
    const before = { ...wm.state }

    expect(service.openFile('asset.pdf')).toBe(false)
    expect(wm.state).toEqual(before)
  })

  it('openFile reports unhandled for directory-ish paths without writing the wm', () => {
    const service = new LayoutController()
    const wm = fakeWm()
    service.attachWm(wm)
    const before = { ...wm.state }

    expect(service.openFile('.')).toBe(false)
    expect(service.openFile('src/')).toBe(false)
    expect(wm.state).toEqual(before)
  })

  it('openFile reports unhandled without an attached wm store', () => {
    const service = new LayoutController()
    expect(service.openFile('notes.md')).toBe(false)
  })

  it('openFile reports unhandled on a tree without leaves', () => {
    const service = new LayoutController()
    const wm = fakeWm()
    wm.state.tree = { kind: 'split', id: 'root', dir: 'row', children: [], weights: [] }
    wm.state.focusedLeafId = undefined
    service.attachWm(wm)

    expect(service.openFile('notes.md')).toBe(false)
  })
})
