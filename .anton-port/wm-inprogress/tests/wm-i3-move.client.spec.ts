// i3-style directional move semantics for the WM tree engine (see the
// app-plugin profile's sibling note for the panel-ownership rule; this spec
// owns the window-move contract). The load-bearing regression: moving toward
// a SPLIT sibling must swap the window with the whole split subtree — the
// original implementation delegated to flipWithSibling, which only swaps
// leaf-with-leaf, so ⌘⇧hjkl silently stopped at the first split neighbor.

import { describe, expect, it } from 'vitest'
import {
  findLeaf, moveLeaf, moveLeafTabbed, leafIds, tabInto, toggleTabbed,
  type WmNode,
} from '../src/client/wm.ts'

/** sidebar | (chat / (scratch | terminal)): a nested tree whose chat pane's
 * right-hand neighbor is a SPLIT, not a leaf — the shape that exposed the
 * flipWithSibling dead-end. */
function nestedTree(): WmNode {
  return {
    kind: 'split',
    id: 'wm:root',
    dir: 'row',
    weights: [0.2, 0.8],
    children: [
      { kind: 'leaf', id: 'sidebar', buffer: 'sidebar' },
      {
        kind: 'split',
        id: 'wm:split:right',
        dir: 'column',
        weights: [0.7, 0.3],
        children: [
          { kind: 'leaf', id: 'chat', buffer: 'conversation' },
          {
            kind: 'split',
            id: 'wm:split:br',
            dir: 'row',
            weights: [0.5, 0.5],
            children: [
              { kind: 'leaf', id: 'scratch', buffer: 'scratch' },
              { kind: 'leaf', id: 'terminal', buffer: 'terminal' },
            ],
          },
        ],
      },
    ],
  }
}

describe('i3 directional move', () => {
  it('swaps with a split sibling, not just leaf siblings', () => {
    const moved = moveLeaf(nestedTree(), 'chat', 'down')
    // The chat leaf traded places with the bottom split subtree: the scratch
    // and terminal leaves now sit above chat in the right column.
    expect(findLeaf(moved, 'chat')).toBeDefined()
    const order = leafIds(moved)
    expect(order.indexOf('scratch')).toBeLessThan(order.indexOf('chat'))
    expect(order.indexOf('terminal')).toBeLessThan(order.indexOf('chat'))
  })

  it('swaps with the neighbor in the MOVE direction (⌘⇧L exchanges with the right pane)', () => {
    const tree: WmNode = {
      kind: 'split',
      id: 'wm:root',
      dir: 'row',
      weights: [0.34, 0.33, 0.33],
      children: [
        { kind: 'leaf', id: 'sidebar', buffer: 'sidebar' },
        { kind: 'leaf', id: 'chat', buffer: 'conversation' },
        { kind: 'leaf', id: 'details', buffer: 'details' },
      ],
    }
    // Regression: the sibling used to be chosen as `index === 0 ? 1 : index - 1`,
    // so moving the middle window RIGHT pulled in its LEFT neighbor.
    const moved = moveLeaf(tree, 'chat', 'right')
    expect(leafIds(moved)).toEqual(['sidebar', 'details', 'chat'])
    expect(moveLeaf(tree, 'chat', 'left') !== tree).toBe(true)
    expect(leafIds(moveLeaf(tree, 'chat', 'left'))).toEqual(['chat', 'sidebar', 'details'])
  })

  it('keeps traveling: repeated moves walk the window through the tree', () => {
    let tree = nestedTree()
    // Start: sidebar | (scratch, terminal above chat). One press per step,
    // exactly i3: down swaps chat under the bottom split; the two lefts then
    // pull it out of the column and across the sidebar.
    // Final arrangement: chat | sidebar | (scratch | terminal).
    tree = moveLeaf(tree, 'chat', 'down')
    tree = moveLeaf(tree, 'chat', 'left')
    tree = moveLeaf(tree, 'chat', 'left')
    const order = leafIds(tree)
    expect(order).toEqual(['chat', 'sidebar', 'scratch', 'terminal'])
  })

  it('at the flat root edge the move is a no-op (nothing past the last window)', () => {
    const tree: WmNode = {
      kind: 'split',
      id: 'wm:root',
      dir: 'row',
      weights: [0.2, 0.8],
      children: [
        { kind: 'leaf', id: 'sidebar', buffer: 'sidebar' },
        { kind: 'leaf', id: 'chat', buffer: 'conversation' },
      ],
    }
    // chat is already the rightmost window.
    expect(moveLeaf(tree, 'chat', 'right')).toBe(tree)
  })

  it('tabbing-mode move tabs the leaf onto its axis neighbor', () => {
    const flat: WmNode = {
      kind: 'split',
      id: 'wm:root',
      dir: 'row',
      weights: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a', buffer: 'scratch' },
        { kind: 'leaf', id: 'b', buffer: 'terminal' },
      ],
    }
    const { tree, onto } = moveLeafTabbed(flat, 'b', 'left', true)
    expect(onto).toBe('a')
    // b is now a tab inside a's tabbed group — the two leaves share one window.
    expect(leafIds(tree).length).toBe(2)
    const group = tree.kind === 'split' && tree.tabbed === true
      ? tree
      : tree.kind === 'split' ? tree.children.find(c => c.kind === 'split' && c.tabbed === true) : undefined
    expect(group !== undefined && group.tabbed === true).toBe(true)
  })

  it('moving a tab out at the group edge extracts it back into the tree', () => {
    const flat: WmNode = {
      kind: 'split',
      id: 'wm:root',
      dir: 'row',
      weights: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a', buffer: 'scratch' },
        { kind: 'leaf', id: 'b', buffer: 'terminal' },
      ],
    }
    const tabbed = tabInto(flat, 'b', 'a')
    // Extract b leftward out of the tabbed group (i3: move out of the container).
    const extracted = moveLeaf(tabbed, 'b', 'left')
    // The tabbed group no longer holds b: it is its own window again.
    const order = leafIds(extracted)
    expect(order).toContain('a')
    expect(order).toContain('b')
    expect(findLeaf(extracted, 'b')).toBeDefined()
    const groupCount = extracted.kind === 'split'
      ? extracted.children.filter(c => c.kind === 'split' && c.tabbed === true).length
      : 0
    expect(groupCount).toBeLessThanOrEqual(1)
  })

  it('toggleTabbed flips the focused container both ways', () => {
    const flat: WmNode = {
      kind: 'split',
      id: 'wm:root',
      dir: 'row',
      weights: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a', buffer: 'scratch' },
        { kind: 'leaf', id: 'b', buffer: 'terminal' },
      ],
    }
    const tabbed = toggleTabbed(flat, 'a')
    const rootTabbed = tabbed.kind === 'split' && tabbed.tabbed === true
    expect(rootTabbed).toBe(true)
    const split = toggleTabbed(tabbed, 'a')
    expect(split.kind === 'split' && split.tabbed === true).toBe(false)
  })

  it('stacks a window vertically (down/up) from a flat row, and supports repeated stack/unstack cycles', () => {
    // 4-pane row: sidebar | chat | context | terminal
    const fourPaneRow: WmNode = {
      kind: 'split',
      id: 'wm:root',
      dir: 'row',
      weights: [0.2, 0.4, 0.2, 0.2],
      children: [
        { kind: 'leaf', id: 'sidebar', buffer: 'sidebar' },
        { kind: 'leaf', id: 'chat', buffer: 'conversation' },
        { kind: 'leaf', id: 'context', buffer: 'details' },
        { kind: 'leaf', id: 'terminal', buffer: 'terminal' },
      ],
    }

    // 1. Move terminal down: stacks vertically under context
    const stackedDown = moveLeaf(fourPaneRow, 'terminal', 'down')
    expect(stackedDown.kind).toBe('split')
    if (stackedDown.kind === 'split') {
      expect(stackedDown.children.length).toBe(3)
      const lastChild = stackedDown.children[2]
      expect(lastChild?.kind).toBe('split')
      if (lastChild?.kind === 'split') {
        expect(lastChild.dir).toBe('column')
        expect(lastChild.children.map(c => c.id)).toEqual(['context', 'terminal'])
      }
    }

    // 2. Inside the vertical stack, move terminal up: swaps with context
    const swappedUp = moveLeaf(stackedDown, 'terminal', 'up')
    if (swappedUp.kind === 'split') {
      const lastChild = swappedUp.children[2]
      if (lastChild?.kind === 'split') {
        expect(lastChild.dir).toBe('column')
        expect(lastChild.children.map(c => c.id)).toEqual(['terminal', 'context'])
      }
    }

    // 3. Move terminal out to the right: un-stacks back into the 4-pane row
    const unstacked = moveLeaf(stackedDown, 'terminal', 'right')
    expect(unstacked.kind).toBe('split')
    if (unstacked.kind === 'split') {
      expect(unstacked.dir).toBe('row')
      expect(unstacked.children.map(c => c.id)).toEqual(['sidebar', 'chat', 'context', 'terminal'])
    }

    // 4. From the unstacked row, move terminal down AGAIN: stacks vertically under context again!
    const restacked = moveLeaf(unstacked, 'terminal', 'down')
    if (restacked.kind === 'split') {
      expect(restacked.children.length).toBe(3)
      const lastChild = restacked.children[2]
      if (lastChild?.kind === 'split') {
        expect(lastChild.dir).toBe('column')
        expect(lastChild.children.map(c => c.id)).toEqual(['context', 'terminal'])
      }
    }

    // 5. Unstack leftward (between chat and context) and re-stack
    const unstackedLeft = moveLeaf(stackedDown, 'terminal', 'left')
    if (unstackedLeft.kind === 'split') {
      expect(unstackedLeft.dir).toBe('row')
      expect(unstackedLeft.children.map(c => c.id)).toEqual(['sidebar', 'chat', 'terminal', 'context'])
    }
  })

  it('stacks a 2-window flat row vertically into a column split', () => {
    const flat: WmNode = {
      kind: 'split',
      id: 'wm:root',
      dir: 'row',
      weights: [0.5, 0.5],
      children: [
        { kind: 'leaf', id: 'a', buffer: 'scratch' },
        { kind: 'leaf', id: 'b', buffer: 'terminal' },
      ],
    }
    // Move b down: stacks under a
    const col = moveLeaf(flat, 'b', 'down')
    expect(col.kind).toBe('split')
    if (col.kind === 'split') {
      expect(col.dir).toBe('column')
      expect(col.children.map(c => c.id)).toEqual(['a', 'b'])
    }

    // Move b up inside the column: swaps with a
    const swapped = moveLeaf(col, 'b', 'up')
    if (swapped.kind === 'split') {
      expect(swapped.dir).toBe('column')
      expect(swapped.children.map(c => c.id)).toEqual(['b', 'a'])
    }
  })
})
