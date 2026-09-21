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
  canClose, countLeaves, defaultTree, findLeaf, findSplit, firstLeafId, focusDirection, keepOnlyLeaf, killBuffer,
  migrateLegacyConversation, sessionBuffer,
  moveLeaf, moveLeafTabbed, tabInto, tabNeighborLeaf, toggleTabbed,
  SCRATCH_BUFFER_ID, SESSION_BUFFER_ID,
  lastLeafId, leafIds, normalizeTree, openBuffer, removeLeaf, setBuffer, setWeights, splitLeaf, swapBuffer,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/wm.ts'
import { createLayoutStore, createScratchStore, createWmStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import { SIDEBAR_DEFAULT } from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { PanelActions, WmTreeSource } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import { WmFrame } from '@deepseek-ai/dsh-client-ui-layout/src/client/WmFrame.tsx'
import type { WmFrameProps } from '@deepseek-ai/dsh-client-ui-layout/src/client/WmFrame.tsx'
import { FilesBuffer } from '@deepseek-ai/dsh-client-ui-layout/src/client/FilesBuffer.tsx'
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

  it('moveLeaf swaps with the axis neighbor and moves out one level at the edge', () => {
    // Along the axis: a swap of the two root children (weights travel too).
    const moved = moveLeaf(defaultTree(), WM_LEAF_CONVERSATION, 'left')
    expect(leafIds(moved)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_SIDEBAR])
    // Against a perpendicular parent: the leaf moves out and wraps the edge
    // neighbor in a fresh split (i3-style reparent).
    // sidebar | [conversation / details] (column) — moving sidebar right wraps.
    const nested: WmNode = {
      kind: 'split', id: 'wm:root', dir: 'row', weights: [0.3, 0.7],
      children: [
        { kind: 'leaf', id: WM_LEAF_SIDEBAR, buffer: 'sidebar' },
        {
          kind: 'split', id: 'wm:inner', dir: 'column', weights: [0.5, 0.5],
          children: [
            { kind: 'leaf', id: WM_LEAF_CONVERSATION, buffer: SESSION_BUFFER_ID },
            { kind: 'leaf', id: WM_LEAF_DETAILS, buffer: 'details' },
          ],
        },
      ],
    }
    const out = moveLeaf(nested, WM_LEAF_SIDEBAR, 'right')
    // Along the axis with a sibling present: sidebar swaps with the whole
    // neighboring subtree (the flip semantic).
    if (out.kind !== 'split') throw new Error('expected split root')
    expect(out.children).toHaveLength(2)
    const [first, second] = out.children
    expect(first?.kind).toBe('split')
    expect(second?.kind).toBe('leaf')
    expect(leafIds(out)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_DETAILS, WM_LEAF_SIDEBAR])
    // The inner column split is untouched by the swap.
    if (first?.kind !== 'split') return
    expect(first.dir).toBe('column')
    expect(leafIds(moved)).toHaveLength(2)
    // Perpendicular parent: moving the conversation LEFT leaves its column —
    // it re-inserts beside the column in the row root.
    const outLeft = moveLeaf(nested, WM_LEAF_CONVERSATION, 'left')
    expect(leafIds(outLeft)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    if (outLeft.kind !== 'split') return
    expect(outLeft.children[1]?.kind).toBe('leaf')
  })

  it('moveLeaf no-ops on a sole leaf, an unknown leaf, and the root axis edge', () => {
    const single = keepOnlyLeaf(defaultTree(), WM_LEAF_CONVERSATION)
    expect(moveLeaf(single, WM_LEAF_CONVERSATION, 'left')).toBe(single)
    const tree = defaultTree()
    expect(moveLeaf(tree, 'nope', 'right')).toBe(tree)
    // Root row edge: no grandparent to move out into.
    expect(moveLeaf(tree, WM_LEAF_SIDEBAR, 'left')).toBe(tree)
  })

  it('focusDirection picks the nearest leaf strictly on the travel side', () => {
    const tree = defaultTree()
    expect(focusDirection(tree, WM_LEAF_CONVERSATION, 'left')).toBe(WM_LEAF_SIDEBAR)
    expect(focusDirection(tree, WM_LEAF_SIDEBAR, 'right')).toBe(WM_LEAF_CONVERSATION)
    // Vertical: no leaf lies above the top edge.
    expect(focusDirection(tree, WM_LEAF_SIDEBAR, 'up')).toBeUndefined()
    const stacked = splitLeaf(defaultTree(), WM_LEAF_CONVERSATION, 'column', 'details', WM_LEAF_DETAILS)
    expect(focusDirection(stacked, WM_LEAF_CONVERSATION, 'down')).toBe(WM_LEAF_DETAILS)
    expect(focusDirection(stacked, WM_LEAF_DETAILS, 'up')).toBe(WM_LEAF_CONVERSATION)
    // The sidebar spans the full height: straight below its center is the
    // details half only.
    expect(focusDirection(stacked, WM_LEAF_SIDEBAR, 'down')).toBe(WM_LEAF_DETAILS)
  })

  it('tabInto / toggleTabbed / moveLeafTabbed implement the i3 tabbed containers', () => {
    const tree = defaultTree()
    // Tab the conversation onto the sidebar: pruning collapses the tree to
    // the bare target leaf, which wraps into the tabbed group.
    const tabbed = tabInto(tree, WM_LEAF_CONVERSATION, WM_LEAF_SIDEBAR)
    const root = tabbed.kind === 'split' ? tabbed : undefined
    expect(root?.tabbed).toBe(true)
    expect(root?.children).toHaveLength(2)
    // Toggling the group's container splits it back out side-by-side.
    const splitOut = toggleTabbed(tabbed, WM_LEAF_SIDEBAR)
    expect(splitOut.kind).toBe('split')
    if (splitOut.kind !== 'split') return
    expect(splitOut.tabbed).toBe(false)
    expect(leafIds(splitOut)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
    // Toggling a plain row split turns it into a tabbed group.
    const grouped = toggleTabbed(tree, WM_LEAF_CONVERSATION)
    if (grouped.kind !== 'split') return
    expect(grouped.tabbed).toBe(true)
    // Inside a tabbed group a directional move reorders the tabs.
    const reordered = moveLeafTabbed(grouped, WM_LEAF_SIDEBAR, 'right', false)
    expect(leafIds(reordered.tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_SIDEBAR])
    // In tabbing mode, a move toward a neighbor TABS onto it and reports the
    // drop target (the shade flash). The tree collapses to the tabbed group.
    const result = moveLeafTabbed(tree, WM_LEAF_SIDEBAR, 'right', true)
    expect(result.onto).toBe(WM_LEAF_CONVERSATION)
    expect(result.tree.kind).toBe('split')
    if (result.tree.kind !== 'split') return
    expect(result.tree.tabbed).toBe(true)
    expect(leafIds(result.tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_SIDEBAR])
    // With tabbing mode off the same move swaps (the plain i3 move).
    expect(moveLeafTabbed(tree, WM_LEAF_SIDEBAR, 'right', false).onto).toBeUndefined()
    expect(leafIds(moveLeafTabbed(tree, WM_LEAF_SIDEBAR, 'right', false).tree))
      .toEqual([WM_LEAF_CONVERSATION, WM_LEAF_SIDEBAR])
  })

  it('moveLeafTabbed reorders tabs in the MOVE DIRECTION (both ways)', () => {
    // Build a ROOT tabbed group of three tabs: [conversation, sidebar, details].
    const three = tabInto(tabInto(
      splitLeaf(defaultTree(), WM_LEAF_CONVERSATION, 'row', WM_LEAF_DETAILS, WM_LEAF_DETAILS),
      WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION,
    ), WM_LEAF_DETAILS, WM_LEAF_SIDEBAR)
    expect(three.kind).toBe('split')
    if (three.kind !== 'split' || three.tabbed !== true) return
    expect(leafIds(three)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_SIDEBAR, WM_LEAF_DETAILS])
    // Middle tab (sidebar) moves right: it becomes the LAST tab.
    expect(leafIds(moveLeafTabbed(three, WM_LEAF_SIDEBAR, 'right', false).tree))
      .toEqual([WM_LEAF_CONVERSATION, WM_LEAF_DETAILS, WM_LEAF_SIDEBAR])
    // The same tab moves left: back to the FRONT (the old direction-blind
    // flipWithSibling made both directions do the identical swap).
    expect(leafIds(moveLeafTabbed(three, WM_LEAF_SIDEBAR, 'left', false).tree))
      .toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    // Last tab (details) moves right = i3 edge move: it LEAVES the stack,
    // which stays behind as a group beside it (the wrap fallback).
    const escaped = moveLeafTabbed(three, WM_LEAF_DETAILS, 'right', false)
    expect(escaped.tree.kind).toBe('split')
    if (escaped.tree.kind !== 'split') return
    expect(escaped.tree.tabbed).not.toBe(true)
    const stack = escaped.tree.children[0]
    expect(stack?.kind).toBe('split')
    if (stack?.kind !== 'split') return
    expect(stack.tabbed).toBe(true)
    expect(leafIds(stack)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_SIDEBAR])
    expect(leafIds(escaped.tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_SIDEBAR, WM_LEAF_DETAILS])
    // First tab (conversation) moves left escapes the other way.
    const escapedLeft = moveLeafTabbed(three, WM_LEAF_CONVERSATION, 'left', false)
    if (escapedLeft.tree.kind !== 'split') return
    expect(escapedLeft.tree.children[0]?.kind).toBe('leaf')
    expect(leafIds(escapedLeft.tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_SIDEBAR, WM_LEAF_DETAILS])
  })

  it('moveLeaf pulls a tab out of a NESTED tabbed group via an axis ancestor', () => {
    // Row root [ tabbedGroup(conversation, sidebar), details ].
    const detailsLeaf = findLeaf(
      splitLeaf(defaultTree(), WM_LEAF_CONVERSATION, 'row', WM_LEAF_DETAILS, WM_LEAF_DETAILS),
      WM_LEAF_DETAILS,
    )
    expect(detailsLeaf).toBeDefined()
    const group = tabInto(defaultTree(), WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION)
    expect(group.kind).toBe('split')
    if (group.kind !== 'split' || detailsLeaf === undefined) return
    const tree = normalizeTree({
      kind: 'split', id: 'test:row', dir: 'row', weights: [0.5, 0.5],
      children: [group, detailsLeaf],
    })
    // sidebar sits at the group's right edge: the outward walk finds the
    // root row split and re-inserts the leaf beside the group (i3 move-out),
    // destroying the stack.
    const moved = moveLeaf(tree, WM_LEAF_SIDEBAR, 'right')
    expect(leafIds(moved)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_SIDEBAR, WM_LEAF_DETAILS])
    expect(moved.kind).toBe('split')
    if (moved.kind !== 'split') return
    expect(moved.children.every(child => child.kind === 'leaf')).toBe(true)

    // Without an axis ancestor (column root over a row-tabbed group) the wrap
    // fallback pulls the tab beside the whole group.
    const colTree = normalizeTree({
      kind: 'split', id: 'test:col', dir: 'column', weights: [0.5, 0.5],
      children: [detailsLeaf, group],
    })
    const wrapped = moveLeaf(colTree, WM_LEAF_SIDEBAR, 'right')
    expect(leafIds(wrapped)).toEqual([WM_LEAF_DETAILS, WM_LEAF_CONVERSATION, WM_LEAF_SIDEBAR])
  })

  it('moveLeaf leaves a non-tabbed root edge move unchanged (i3 workspace edge)', () => {
    const tree = defaultTree() // row [sidebar, conversation]
    expect(moveLeaf(tree, WM_LEAF_CONVERSATION, 'right')).toBe(tree)
  })

  it('tabNeighborLeaf cycles tabs inside a stack and falls back at edges', () => {
    const three = tabInto(tabInto(
      splitLeaf(defaultTree(), WM_LEAF_CONVERSATION, 'row', WM_LEAF_DETAILS, WM_LEAF_DETAILS),
      WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION,
    ), WM_LEAF_DETAILS, WM_LEAF_SIDEBAR)
    expect(three.kind).toBe('split')
    if (three.kind !== 'split') return
    // In-order cycle: conversation -> sidebar -> details.
    expect(tabNeighborLeaf(three, WM_LEAF_CONVERSATION, 'right')).toBe(WM_LEAF_SIDEBAR)
    expect(tabNeighborLeaf(three, WM_LEAF_SIDEBAR, 'right')).toBe(WM_LEAF_DETAILS)
    expect(tabNeighborLeaf(three, WM_LEAF_SIDEBAR, 'left')).toBe(WM_LEAF_CONVERSATION)
    // Edges fall through (undefined = geometric focus decides).
    expect(tabNeighborLeaf(three, WM_LEAF_CONVERSATION, 'left')).toBeUndefined()
    expect(tabNeighborLeaf(three, WM_LEAF_DETAILS, 'right')).toBeUndefined()
    // Perpendicular directions never cycle a row-tabbed group.
    expect(tabNeighborLeaf(three, WM_LEAF_CONVERSATION, 'down')).toBeUndefined()
    // A non-tabbed parent never yields a tab neighbor.
    expect(tabNeighborLeaf(defaultTree(), WM_LEAF_SIDEBAR, 'right')).toBeUndefined()
  })

  it('canClose: every window closes except the last one standing', () => {    const tree = shipped3()
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
/** Extra session summaries the useSessions stub exposes beside the current one. */
const extraSessions: { id: string; displayTitle: string }[] = []
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

function mountFrame(initialTree?: WmNode, workspaces?: { id: string; title: string; sessionIds?: string[] }[]) {
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
        : {
          [current]: { id: current, displayTitle: 'Test', cwd: '/proj/wm', running: false, blank: selectedSessionBlank.current, updatedAt: 1 },
          ...Object.fromEntries(extraSessions.map(s => [s.id, { ...s, running: false, blank: false, updatedAt: 1 }])),
        },
      current,
      phase: 'ready',
    } as unknown as SessionListState
    return sel(sessionState)
  }) as never
  const workspaceState: WorkspaceListState = {
    items: (workspaces ?? []).map(w => ({
      workspaceId: w.id as never, path: `/projects/${w.id}`, title: w.title,
      sessionIds: (w.sessionIds ?? []) as never[], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
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
      rebindPane={(leafId, sessionId) => {
        const snapshot = wm.getSnapshot()
        const buffer = sessionBuffer(sessionId)
        act(() => {
          wm.actions.setBuffers([...snapshot.buffers.filter(b => b.id !== buffer.id), buffer])
          wm.actions.setTree(swapBuffer(snapshot.tree, leafId, buffer.id))
        })
      }}
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
interface PressMods {
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  code?: string
}

function press(key: string, mods: PressMods = {}): void {
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
  extraSessions.length = 0
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
    const { getByText, getByTestId, getAllByLabelText, queryByText, queryByTestId, container } = mountFrame()
    const modeLineText = (text: string): Element[] =>
      [...container.querySelectorAll('[class*=bufferName]')].filter(el => el.textContent === text)
    expect(getByText('Workspace')).toBeTruthy()
    expect(modeLineText('Chat').length).toBeGreaterThan(0)
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
    expect(slotCalls.find(c => c.key === 'conversation')!.props).toEqual({
      layoutSpan: 'single',
      rebindPane: expect.any(Function),
    })
    expect(slotCalls.map(c => c.key)).toContain('shell.overlay')
  })

  it('mode-line close removes any leaf with a remaining window behind it', () => {
    const { container, wm } = mountFrame()
    const closeButtonOf = (buffer: string): HTMLButtonElement =>
      container.querySelector(`[data-buffer="${buffer}"] button[aria-label="Close"]`) as HTMLButtonElement
    // The conversation pane closes too: chat returns through C-x b.
    act(() => { closeButtonOf('session').click() })
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR])
    expect([...container.querySelectorAll('[class*=bufferName]')].some(el => el.textContent === 'Chat')).toBe(false)
  })

  it('single-pane mode line keeps tidy + expand/restore; only flip and close need a sibling', () => {
    const { container, wm } = mountFrame(keepOnlyLeaf(defaultTree(), WM_LEAF_CONVERSATION))
    const conv = '[data-buffer="session"] '
    // Tidy and Expand stay reachable on the last window (C-x 1 must be
    // clickable there, and expanding must leave a visible restore).
    expect(container.querySelector(`${conv}button[aria-label="Tidy panes"]`)).toBeTruthy()
    expect(container.querySelector(`${conv}button[aria-label="Expand pane"]`)).toBeTruthy()
    expect(container.querySelector(`${conv}button[aria-label="Flip pane"]`)).toBeNull()
    expect(container.querySelector(`${conv}button[aria-label="Close"]`)).toBeNull()
    act(() => { (container.querySelector(`${conv}button[aria-label="Expand pane"]`) as HTMLElement).click() })
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION])
    const restore = container.querySelector(`${conv}button[aria-label="Restore layout"]`) as HTMLElement
    expect(restore).toBeTruthy()
    act(() => { restore.click() })
    // Restore returns the pre-expand layout (here: the single pane itself).
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION])
    expect(container.querySelector(`${conv}button[aria-label="Expand pane"]`)).toBeTruthy()
  })

  it('context toggle pins the home details leaf as a fixed-width right column', () => {
    const { getByLabelText, container, wm } = mountFrame()
    const wrapperOf = (buffer: string): HTMLElement | null =>
      container.querySelector(`[data-buffer="${buffer}"]`)?.parentElement ?? null
    act(() => { getByLabelText('Toggle context panel').click() })
    // The home details leaf is the canonical id, placed after the anchor.
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION, WM_LEAF_DETAILS])
    // The pane is pinned to the context sidebar natural width (CONTEXT_DEFAULT = 552px).
    expect(wrapperOf('details')?.style.flex).toBe('0 0 552px')
    expect(wrapperOf('session')?.style.flex).toBe('1 1 0%')
    act(() => { getByLabelText('Toggle context panel').click() })
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_SIDEBAR, WM_LEAF_CONVERSATION])
  })

  it('sash drag on the context boundary writes the details width preference', () => {
    const { getByLabelText, container, layout } = mountFrame()
    act(() => { getByLabelText('Toggle context panel').click() })
    // The context sash is the one directly before the details pane wrapper.
    const detailsWrapper = container.querySelector('[data-buffer="details"]')?.parentElement
    if (detailsWrapper === null || detailsWrapper === undefined) throw new Error('details wrapper missing')
    const contextSash = detailsWrapper.previousElementSibling as HTMLElement
    expect(contextSash.className).toContain('sash')
    const down = new PointerEvent('pointerdown', { pointerId: 1, clientX: 1280, bubbles: true })
    const move = new PointerEvent('pointermove', { pointerId: 1, clientX: 1180, bubbles: true })
    const up = new PointerEvent('pointerup', { pointerId: 1, clientX: 1180, bubbles: true })
    act(() => { contextSash.dispatchEvent(down) })
    act(() => { contextSash.dispatchEvent(move) })
    act(() => { contextSash.dispatchEvent(up) })
    // Dragging left widens the right-hand context column: 552 + 100 = 652.
    expect(layout.getSnapshot().details).toBe(652)
    // Tidy panes restores the original context width (CONTEXT_DEFAULT = 552).
    const tidy = container.querySelector('[data-buffer="session"] button[aria-label="Tidy panes"]') as HTMLElement
    act(() => { tidy.click() })
    expect(layout.getSnapshot().details).toBe(552)
  })

  it('context in a stacked configuration restricts horizontally to fixed sidebar size while chat expands', () => {
    // sidebar | conversation | [details / terminal-1]
    const stackedTree: WmNode = {
      kind: 'split',
      id: 'wm:root',
      dir: 'row',
      weights: [0.18, 0.41, 0.41],
      children: [
        { kind: 'leaf', id: WM_LEAF_SIDEBAR, buffer: 'sidebar' },
        { kind: 'leaf', id: WM_LEAF_CONVERSATION, buffer: SESSION_BUFFER_ID },
        {
          kind: 'split',
          id: 'wm:split:context-col',
          dir: 'column',
          weights: [0.5, 0.5],
          children: [
            { kind: 'leaf', id: WM_LEAF_DETAILS, buffer: 'details' },
            { kind: 'leaf', id: 'leaf:term:1', buffer: 'terminal' },
          ],
        },
      ],
    }
    const { container } = mountFrame(stackedTree)
    const wrapperOf = (buffer: string): HTMLElement | null =>
      container.querySelector(`[data-buffer="${buffer}"]`)?.parentElement ?? null
    const detailsWrapper = wrapperOf('details')
    const columnSplitWrapper = detailsWrapper?.closest('[class*=split]')?.parentElement
    expect(columnSplitWrapper?.style.flex).toBe('0 0 552px')
    expect(wrapperOf('session')?.style.flex).toBe('1 1 0%')
  })

  it('context expands fully when no other content windows exist in the split', () => {
    // Only details in the tree:
    const onlyDetailsTree: WmNode = { kind: 'leaf', id: WM_LEAF_DETAILS, buffer: 'details' }
    const { container: c1 } = mountFrame(onlyDetailsTree)
    const details1 = c1.querySelector('[data-buffer="details"]') as HTMLElement
    expect(details1).toBeTruthy()

    // sidebar and details alone in a row split (no conversation):
    const sidebarDetailsTree: WmNode = {
      kind: 'split',
      id: 'wm:root',
      dir: 'row',
      weights: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: WM_LEAF_SIDEBAR, buffer: 'sidebar' },
        { kind: 'leaf', id: WM_LEAF_DETAILS, buffer: 'details' },
      ],
    }
    const { container: c2 } = mountFrame(sidebarDetailsTree)
    const wrapperOf = (c: HTMLElement, buffer: string): HTMLElement | null =>
      c.querySelector(`[data-buffer="${buffer}"]`)?.parentElement ?? null
    expect(wrapperOf(c2, 'sidebar')?.style.flex).toBe('0 0 346px')
    expect(wrapperOf(c2, 'details')?.style.flex).toBe('1 1 0%')
  })

  it('⌘⇧L moves the focused window right; ⌘H/⌘J navigate focus; mode line carries the four move buttons', () => {
    const { container, wm } = mountFrame()
    // The mode line renders one directional move button per direction.
    for (const dir of ['left', 'right', 'up', 'down']) {
      expect(container.querySelector(`[aria-label="Move pane ${dir}"]`)).toBeTruthy()
    }
    // ⌘⇧L moves the focused (sidebar) window right: swap with the neighbor.
    press('L', { metaKey: true, shiftKey: true, code: 'KeyL' })
    expect(leafIds(wm.getSnapshot().tree)).toEqual([WM_LEAF_CONVERSATION, WM_LEAF_SIDEBAR])
    // ⌘L focuses right: to the (moved) sidebar leaf.
    press('l', { metaKey: true, code: 'KeyL' })
    expect(wm.getSnapshot().focusedLeafId).toBe(WM_LEAF_SIDEBAR)
    // ⌘H back left: to the conversation leaf.
    press('h', { metaKey: true, code: 'KeyH' })
    expect(wm.getSnapshot().focusedLeafId).toBe(WM_LEAF_CONVERSATION)
    // ⌘J from the top row: nothing lies below — focus stands.
    press('j', { metaKey: true, code: 'KeyJ' })
    expect(wm.getSnapshot().focusedLeafId).toBe(WM_LEAF_CONVERSATION)
  })

  it('⌘⇧E tabs the container: strip renders one tab per window, clicking focuses', () => {
    const { container, wm } = mountFrame()
    // Split the conversation right so the root container has three leaves.
    act(() => { (container.querySelector('[data-buffer="session"] button[aria-label="Split right"]') as HTMLElement).click() })
    // ⌘⇧E converts the focused container into a tabbed group.
    press('E', { metaKey: true, shiftKey: true, code: 'KeyE' })
    const tree = wm.getSnapshot().tree
    expect(tree.kind === 'split' && tree.tabbed === true).toBe(true)
    // The strip renders one tab per window; clicking focuses that leaf.
    const tabs = [...container.querySelectorAll('[class*="tabStrip"] [role="tab"]')]
    expect(tabs).toHaveLength(2)
    act(() => { (tabs[tabs.length - 1] as HTMLElement).click() })
    expect(wm.getSnapshot().focusedLeafId).toBeDefined()
  })

  it('tabbing mode: ⌘⇧L tabs the window onto the neighbor with the drop shade', () => {
    const { container, wm, layout } = mountFrame()
    act(() => { layout.actions.toggleTabbing() })
    // Focus starts on the leftmost leaf; ⌘⇧L moves toward the chat window.
    press('L', { metaKey: true, shiftKey: true, code: 'KeyL' })
    // The tree gained a tabbed group and the target flashes the shade.
    expect(container.querySelector('[class*="tabShade"]')).toBeTruthy()
    expect(JSON.stringify(wm.getSnapshot().tree)).toContain('"tabbed":true')
    // Focus stays on the absorbing pane during the flash.
    expect(wm.getSnapshot().focusedLeafId).toBe(WM_LEAF_CONVERSATION)
  })

  it('mode-line split inserts a new pane beside the target', () => {
    const { container, wm } = mountFrame()
    // The conversation pane's Split right clones the buffer into a second
    // window beside it (a buffer is content; windows are views).
    const convSplit = container.querySelector('[data-buffer="session"] button[aria-label="Split right"]') as HTMLButtonElement
    act(() => { convSplit.click() })
    expect(leafIds(wm.getSnapshot().tree)).toHaveLength(3)
    expect([...container.querySelectorAll('[class*=bufferName]')].filter(el => el.textContent === 'Chat')).toHaveLength(2)
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

describe('per-window session buffers', () => {
  /** A tree whose chat leaf is pinned to session s-1 (registry entry present). */
  function pinnedFrame() {
    extraSessions.push({ id: 's-1', displayTitle: 'Alpha' })
    const tree: WmNode = {
      kind: 'split', id: 'wm:root', dir: 'row', weights: [0.2, 0.8],
      children: [
        { kind: 'leaf', id: WM_LEAF_SIDEBAR, buffer: 'sidebar' },
        { kind: 'leaf', id: WM_LEAF_CONVERSATION, buffer: 'buffer:session:s-1' },
      ],
    }
    const frame = mountFrame(tree)
    act(() => {
      frame.wm.actions.setBuffers([...frame.wm.getSnapshot().buffers.filter(b => b.id !== 'buffer:session:s-1'), sessionBuffer('s-1')])
    })
    return frame
  }

  it('a pinned pane renders the conversation slot with the pin in opts + owner props and a titled mode line', () => {
    const { slotCalls, container } = pinnedFrame()
    const conv = slotCalls.filter(c => c.key === 'conversation').at(-1)!
    expect(conv.props).toMatchObject({ scopeSessionId: 's-1', layoutSpan: 'single' })
    expect([...container.querySelectorAll('[class*=bufferName]')].some(el => el.textContent === 'Chat · Alpha')).toBe(true)
  })

  it('splitting a pinned pane clones into a NEW registry entry with the same session', () => {
    const { container, wm } = pinnedFrame()
    act(() => {
      ;(container.querySelector('[data-buffer="session"] button[aria-label="Split right"]') as HTMLElement).click()
    })
    const pins = wm.getSnapshot().buffers.filter(b => b.kind === 'session' && b.sessionId === 's-1')
    expect(pins.length).toBe(2)
    expect(new Set(pins.map(b => b.id)).size).toBe(2)
    // Both windows show a buffer pinned to s-1.
    const buffersOf = (t: WmNode): string[] => (t.kind === 'leaf' ? [t.buffer] : t.children.flatMap(buffersOf))
    expect(buffersOf(wm.getSnapshot().tree).filter(id => id.startsWith('buffer:session:')).length).toBe(2)
  })

  it('C-x b lists one candidate per workspace session and Enter pins the focused window', () => {
    extraSessions.push({ id: 's-1', displayTitle: 'Alpha' })
    const { getByLabelText, wm } = mountFrame(undefined, [{ id: 'ws-1', title: 'One', sessionIds: ['s-1'] }])
    act(() => { wm.actions.setFocus(WM_LEAF_SIDEBAR) })
    press('x', { ctrlKey: true })
    press('b')
    const input = getByLabelText('Switch buffer') as HTMLInputElement
    typeInput(input, 'Alpha')
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    // The focused sidebar window switched to the pinned session buffer; the
    // registry gained its entry (Emacs: a switch, never a split).
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('buffer:session:s-1')
    expect(wm.getSnapshot().buffers.some(b => b.id === 'buffer:session:s-1')).toBe(true)
    expect(leafIds(wm.getSnapshot().tree)).toHaveLength(2)
  })

  it('a sidebar current change re-binds ONLY the focused chat window', () => {
    const { rerenderFrame, wm } = pinnedFrame()
    extraSessions.push({ id: 's-next', displayTitle: 'Next' })
    act(() => { wm.actions.setFocus(WM_LEAF_CONVERSATION) })
    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    // The focused chat pane pinned itself to the new current…
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_CONVERSATION)?.buffer).toBe('buffer:session:s-next')
    expect(wm.getSnapshot().buffers.some(b => b.id === 'buffer:session:s-next')).toBe(true)
    // …and the sidebar leaf kept its buffer (only the focused window moved).
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('sidebar')
  })

  it('two chat windows report layoutSpan multi; one reports single', () => {
    const { container, slotCalls } = pinnedFrame()
    expect((slotCalls.filter(c => c.key === 'conversation').at(-1)!.props as { layoutSpan: string }).layoutSpan).toBe('single')
    act(() => {
      ;(container.querySelector('[data-buffer="session"] button[aria-label="Split right"]') as HTMLElement).click()
    })
    expect((slotCalls.filter(c => c.key === 'conversation').at(-1)!.props as { layoutSpan: string }).layoutSpan).toBe('multi')
  })

  it("the pane-bound rebindPane owner prop re-pins exactly that leaf (a composer's new session)", () => {
    extraSessions.push({ id: 's-2', displayTitle: 'Beta' })
    const { slotCalls, wm } = pinnedFrame()
    const { rebindPane } = slotCalls.filter(c => c.key === 'conversation').at(-1)!.props as { rebindPane: (sessionId: string) => void }
    act(() => { rebindPane('s-2') })
    // The chat leaf re-pinned to s-2; the sidebar leaf and the global
    // selection (sessionsListSnapshot.current) stayed put.
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_CONVERSATION)?.buffer).toBe('buffer:session:s-2')
    expect(wm.getSnapshot().buffers.some(b => b.id === 'buffer:session:s-2')).toBe(true)
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('sidebar')
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
    expect(container.querySelector('[data-buffer="session"]')!.hasAttribute('data-focused')).toBe(true)
    expect(container.querySelector('[data-buffer="sidebar"]')!.hasAttribute('data-focused')).toBe(false)
  })

  it('a stale focused id falls back to the first leaf', () => {
    const { container, wm } = mountFrame()
    act(() => { wm.actions.setFocus('wm:gone') })
    // Effective focus normalizes (no pane marked focused-stale); the frame
    // still renders, and the first pane holds the highlight resolution.
    expect(container.querySelector('[data-buffer]')).toBeTruthy()
    act(() => { container.querySelector('[data-buffer="session"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
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
    expect(buffers(wm.getSnapshot().tree)).toEqual(['sidebar', SESSION_BUFFER_ID, SESSION_BUFFER_ID])
    press('x', { ctrlKey: true })
    press('3')
    expect(buffers(wm.getSnapshot().tree)).toEqual(['sidebar', SESSION_BUFFER_ID, SESSION_BUFFER_ID, SESSION_BUFFER_ID])
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
    expect(buffers(wm.getSnapshot().tree)).toEqual([SESSION_BUFFER_ID, SESSION_BUFFER_ID])
    expect(findLeaf(wm.getSnapshot().tree, wm.getSnapshot().focusedLeafId ?? '')?.buffer).toBe(SESSION_BUFFER_ID)
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
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe(SESSION_BUFFER_ID)
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
    expect(instance.getSnapshot().buffers.map(b => b.id)).toEqual(['sidebar', SESSION_BUFFER_ID, 'details', 'settings'])
    // Old persisted snapshot: leaves carry bare kind ids, no buffers array.
    // The ids ARE the singleton ids, so the tree renders as-is; reconcile
    // heals the registry side.
    act(() => { instance.actions.reconcile() })
    expect(instance.getSnapshot().buffers.map(b => b.id)).toEqual(['sidebar', SESSION_BUFFER_ID, 'details', 'settings'])
  })

  it('sessionBuffer: undefined pins follow-current, a session id yields the deterministic pinned id', () => {
    expect(sessionBuffer()).toEqual({ id: SESSION_BUFFER_ID, kind: 'session' })
    expect(sessionBuffer('s-1')).toEqual({ id: 'buffer:session:s-1', kind: 'session', sessionId: 's-1' })
  })

  it('defaultTree seeds a follow-current session buffer in the chat leaf', () => {
    expect(findLeaf(defaultTree(), WM_LEAF_CONVERSATION)?.buffer).toBe(SESSION_BUFFER_ID)
  })

  it('migrateLegacyConversation rewrites legacy buffers and leaves, idempotently', () => {
    const legacyBuffers = [
      { id: 'sidebar', kind: 'sidebar' as const },
      { id: 'conversation', kind: 'conversation' as const },
      { id: 'details', kind: 'details' as const },
    ]
    const legacyTree: WmNode = {
      kind: 'split', id: 'wm:root', dir: 'row', weights: [0.2, 0.8],
      children: [
        { kind: 'leaf', id: WM_LEAF_SIDEBAR, buffer: 'sidebar' },
        { kind: 'leaf', id: WM_LEAF_CONVERSATION, buffer: 'conversation' },
      ],
    }
    const migrated = migrateLegacyConversation(legacyBuffers, legacyTree)
    expect(migrated.buffers.map(b => b.id)).toEqual(['sidebar', SESSION_BUFFER_ID, 'details'])
    expect(findLeaf(migrated.tree, WM_LEAF_CONVERSATION)?.buffer).toBe(SESSION_BUFFER_ID)
    // Idempotent: a second pass changes nothing.
    const again = migrateLegacyConversation(migrated.buffers, migrated.tree)
    expect(again.buffers).toEqual(migrated.buffers)
    expect(again.tree).toEqual(migrated.tree)
    // A pinned session buffer survives the migration untouched.
    const withPin = [...migrated.buffers, sessionBuffer('s-9')]
    expect(migrateLegacyConversation(withPin, migrated.tree).buffers).toContainEqual(sessionBuffer('s-9'))
  })

  it('store reconcile migrates a persisted legacy conversation snapshot (both halves)', () => {
    window.localStorage.setItem('dsh.layout.wm', JSON.stringify({
      tree: {
        kind: 'split', id: 'wm:root', dir: 'row', weights: [0.2, 0.8],
        children: [
          { kind: 'leaf', id: WM_LEAF_SIDEBAR, buffer: 'sidebar' },
          { kind: 'leaf', id: WM_LEAF_CONVERSATION, buffer: 'conversation' },
        ],
      },
      buffers: [{ id: 'sidebar', kind: 'sidebar' }, { id: 'conversation', kind: 'conversation' }, { id: 'details', kind: 'details' }, { id: 'settings', kind: 'settings' }],
      focusedLeafId: undefined,
    }))
    const instance = createWmStore().create()
    act(() => { instance.actions.reconcile() })
    expect(instance.getSnapshot().buffers.some(b => b.kind === 'conversation')).toBe(false)
    expect(instance.getSnapshot().buffers.some(b => b.id === SESSION_BUFFER_ID)).toBe(true)
    expect(findLeaf(instance.getSnapshot().tree, WM_LEAF_CONVERSATION)?.buffer).toBe(SESSION_BUFFER_ID)
    // Running again is a no-op (idempotent under repeated reconcile).
    const after = instance.getSnapshot()
    act(() => { instance.actions.reconcile() })
    expect(instance.getSnapshot().buffers).toEqual(after.buffers)
    expect(instance.getSnapshot().tree).toEqual(after.tree)
  })

  it('killBuffer refuses the follow-current singleton, re-homes pinned session panes, and swaps files leaves to scratch', () => {
    const tree = defaultTree()
    const buffers = [
      { id: 'sidebar', kind: 'sidebar' as const },
      sessionBuffer(),
      { id: 'details', kind: 'details' as const },
      sessionBuffer('s-1'),
      { id: 'buffer:files:1', kind: 'files' as const, path: '/tmp' },
    ]
    // The follow-current singleton kill is refused.
    const refused = killBuffer({ buffers, tree }, SESSION_BUFFER_ID)
    expect(refused.buffers.map(b => b.id)).toEqual(['sidebar', SESSION_BUFFER_ID, 'details', 'buffer:session:s-1', 'buffer:files:1'])
    // A pinned session buffer's kill re-homes its windows to follow-current
    // and prunes the registry (the chat surface never dies; the pin does).
    const pinnedTree = splitLeaf(tree, WM_LEAF_CONVERSATION, 'row', 'buffer:session:s-1', 'leaf-pin')
    const unpinned = killBuffer({ buffers, tree: pinnedTree }, 'buffer:session:s-1')
    expect(unpinned.buffers.some(b => b.id === 'buffer:session:s-1')).toBe(false)
    expect(findLeaf(unpinned.tree, 'leaf-pin')?.buffer).toBe(SESSION_BUFFER_ID)
    // A files buffer kills through: its leaf swaps to *scratch*, created on
    // demand.
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

  it('ido path semantics: ~ resolves home, a slash descends, the tail narrows', async () => {
    const { container } = mountFrame(undefined, [])
    press('x', { ctrlKey: true })
    press('f', { ctrlKey: true })
    const input = () => container.querySelector('[data-ido] input') as HTMLInputElement
    await act(async () => { await Promise.resolve() })

    // `~` alone jumps the prompt to the host home directory.
    await act(async () => { fireEvent.change(input(), { target: { value: '~' } }) })
    await act(async () => { await Promise.resolve() })
    expect(listDirectoryLog.at(-1)).toBe('/home/u')

    // Relative descent on a fresh prompt: a trailing slash commits the
    // matched directory — exact names win, flex falls back — and the tail
    // narrows what remains.
    press('Escape')
    press('x', { ctrlKey: true })
    press('f', { ctrlKey: true })
    await act(async () => { await Promise.resolve() })
    await act(async () => { fireEvent.change(input(), { target: { value: 'a/' } }) })
    await act(async () => { await Promise.resolve() })
    expect(listDirectoryLog.at(-1)).toBe('/proj/wm/a')
    expect(container.querySelectorAll('[data-ido] li').length).toBe(1)
    await act(async () => { fireEvent.change(input(), { target: { value: 'in' } }) })
    expect(container.querySelectorAll('[data-ido] li').length).toBe(1)
    expect(container.querySelector('[data-ido] li')?.textContent).toContain('inner')
  })

  it('C-x ←/→ cycle the focused leaf through the whole registry', () => {
    const { wm } = mountFrame()
    act(() => { wm.actions.setFocus(WM_LEAF_SIDEBAR) })
    press('x', { ctrlKey: true })
    // Registry order: Workspace, Chat, Context, Settings, *scratch*. Chat is
    // shown in its own window — cycling lands on it anyway (clones, not skips).
    press('ArrowRight')
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe(SESSION_BUFFER_ID)
    press('x', { ctrlKey: true })
    press('ArrowRight')
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('details')
    press('x', { ctrlKey: true })
    press('ArrowRight')
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('settings')
    press('x', { ctrlKey: true })
    press('ArrowRight')
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe(SCRATCH_BUFFER_ID)
    press('x', { ctrlKey: true })
    press('ArrowLeft') // back through the same order
    expect(findLeaf(wm.getSnapshot().tree, WM_LEAF_SIDEBAR)?.buffer).toBe('settings')
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
        { kind: 'leaf', id: 'b', buffer: SESSION_BUFFER_ID },
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
        { kind: 'leaf', id: WM_LEAF_CONVERSATION, buffer: SESSION_BUFFER_ID },
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
    act(() => { (container.querySelector('[data-buffer="session"] button[aria-label="Split right"]') as HTMLElement).click() })
    expect(echoText().textContent).toBe('Split right')
    // Close the cloned (second) conversation window.
    const convCloses = container.querySelectorAll('[data-buffer="session"] button[aria-label="Close"]')
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
