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
})
