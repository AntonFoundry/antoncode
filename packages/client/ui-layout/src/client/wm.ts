/**
 * Window-tree model for the Emacs-style window manager: a binary-plus tree of
 * splits (row/column with weight fractions) whose leaves each show one
 * registered buffer slot (sidebar | conversation | details). Every operation
 * here is pure and immutable — each takes a tree and returns a new tree,
 * never mutating its input (the tree lives in the WM store; WmFrame and
 * LayoutController write transformed trees back through `setTree`).
 *
 * Invariant: a tree always contains at least one leaf, and at least one
 * `conversation` leaf (the session header + composer home) — `removeLeaf`
 * no-ops on the last leaf, and `canClose` denies closing the only
 * conversation leaf.
 */

/** Split orientation: children laid out side by side (row) or stacked (column). */
export type WmDirection = 'row' | 'column'

/** The three registered buffer slots a leaf can show. */
export type WmBufferKind = 'sidebar' | 'conversation' | 'details'

/** A leaf window: shows exactly one buffer slot. */
export interface WmLeaf { kind: 'leaf'; id: string; buffer: WmBufferKind }

/**
 * A split window: children laid out along `dir`, sized by `weights` —
 * fractional flex-grow values aligned with `children` (one per child).
 * Weights are not renormalized to sum to 1 by every operation; they are
 * ratios, and flex layout is scale-free.
 */
export interface WmSplit {
  kind: 'split'
  id: string
  dir: WmDirection
  children: WmNode[]
  weights: number[]
}

/** Any window-tree node. */
export type WmNode = WmLeaf | WmSplit

/** Stable leaf ids of the default tree (mirroring their buffer kind). */
export const WM_LEAF_SIDEBAR = 'sidebar'
export const WM_LEAF_CONVERSATION = 'conversation'
export const WM_LEAF_DETAILS = 'details'

/**
 * The shipped layout: sidebar | (conversation | details) as fractional
 * weights of the 280 : 1 : 640 contract columns — the sidebar takes 280
 * parts, the main area splits one part for the conversation against 640 for
 * details.
 * @returns a fresh default tree (sidebar + conversation + details).
 */
export function defaultTree(): WmNode {
  return {
    kind: 'split',
    id: 'wm:root',
    dir: 'row',
    children: [
      { kind: 'leaf', id: WM_LEAF_SIDEBAR, buffer: 'sidebar' },
      {
        kind: 'split',
        id: 'wm:main',
        dir: 'row',
        children: [
          { kind: 'leaf', id: WM_LEAF_CONVERSATION, buffer: 'conversation' },
          { kind: 'leaf', id: WM_LEAF_DETAILS, buffer: 'details' },
        ],
        weights: [1 / 641, 640 / 641],
      },
    ],
    // Sidebar : (conversation + details) = 280 : 640 contract parts.
    weights: [280 / 920, 640 / 920],
  }
}

/**
 * Find a leaf by id.
 * @param node - tree to search.
 * @param leafId - leaf id to find.
 * @returns the leaf, or undefined when absent.
 */
export function findLeaf(node: WmNode, leafId: string): WmLeaf | undefined {
  if (node.kind === 'leaf') return node.id === leafId ? node : undefined
  for (const child of node.children) {
    const hit = findLeaf(child, leafId)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Find a split by id (sash resizes address the parent split directly).
 * @param node - tree to search.
 * @param splitId - split id to find.
 * @returns the split, or undefined when absent.
 */
export function findSplit(node: WmNode, splitId: string): WmSplit | undefined {
  if (node.kind === 'split') {
    if (node.id === splitId) return node
    for (const child of node.children) {
      const hit = findSplit(child, splitId)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

/**
 * Collect every leaf id in depth order.
 * @param node - tree to walk.
 * @returns the leaf ids, first (leftmost/topmost) last (rightmost/bottommost).
 */
export function leafIds(node: WmNode): string[] {
  if (node.kind === 'leaf') return [node.id]
  return node.children.flatMap(leafIds)
}

/**
 * Count leaves showing one buffer kind.
 * @param node - tree to walk.
 * @param buffer - buffer kind to count.
 * @returns the number of leaves showing `buffer`.
 */
export function countLeaves(node: WmNode, buffer: WmBufferKind): number {
  if (node.kind === 'leaf') return node.buffer === buffer ? 1 : 0
  return node.children.reduce((sum, child) => sum + countLeaves(child, buffer), 0)
}

/**
 * Whether a leaf may close: `conversation` is the session surface's only
 * home, so the LAST conversation leaf is not closable; sidebar and details
 * close freely.
 * @param node - tree containing the leaf.
 * @param leafId - leaf to test.
 * @returns false only when the leaf is the only conversation leaf.
 */
export function canClose(node: WmNode, leafId: string): boolean {
  const leaf = findLeaf(node, leafId)
  if (leaf === undefined) return false
  if (leaf.buffer !== 'conversation') return true
  return countLeaves(node, 'conversation') > 1
}

/**
 * Remove a leaf and prune the splits it leaves behind: a split with one
 * child collapses to that child. Removing the last leaf is a no-op (a tree
 * always keeps at least one window).
 * @param node - tree to transform.
 * @param leafId - leaf to remove.
 * @returns the pruned tree (same reference when the leaf is absent or the
 * removal would empty the tree).
 */
export function removeLeaf(node: WmNode, leafId: string): WmNode {
  if (leafIds(node).length <= 1) return node
  if (findLeaf(node, leafId) === undefined) return node
  // Prune bottom-up carrying each surviving child's old weight, so a nested
  // collapse renormalizes over the split's surviving share.
  const prune = (n: WmNode): { node: WmNode; weight: number } | null => {
    if (n.kind === 'leaf') return n.id === leafId ? null : { node: n, weight: 1 }
    const kept = n.children
      .map((child, i) => {
        const pruned = prune(child)
        return pruned === null ? null : { ...pruned, weight: pruned.weight * (n.weights[i] ?? 0) }
      })
      .filter((entry): entry is { node: WmNode; weight: number } => entry !== null)
    if (kept.length === 0) return null
    if (kept.length === 1) {
      const only = kept[0]
      if (only !== undefined) return only
      return null
    }
    const total = kept.reduce((sum, entry) => sum + entry.weight, 0)
    const safe = total > 0 ? total : 1
    return {
      node: {
        ...n,
        children: kept.map(entry => entry.node),
        weights: kept.map(entry => entry.weight / safe),
      },
      weight: total,
    }
  }
  return prune(node)?.node ?? node
}

/**
 * Replace a leaf with a split along `dir` whose children are the old leaf and
 * the new leaf (in that order, unless `position` is 'before'), with equal
 * weights — the Emacs split-below/split-right gesture; 'before' re-attaches
 * a buffer at the anchor's edge (the sidebar toggle's tree-left restore).
 * @param node - tree to transform.
 * @param leafId - leaf to split.
 * @param dir - orientation of the new split.
 * @param newBuffer - buffer the new leaf shows.
 * @param newLeafId - id of the new leaf.
 * @param position - whether the new leaf lands after (default) or before the old leaf.
 * @returns the transformed tree (unchanged when `leafId` is absent).
 */
export function splitLeaf(
  node: WmNode, leafId: string, dir: WmDirection, newBuffer: WmBufferKind, newLeafId: string,
  position: 'after' | 'before' = 'after',
): WmNode {
  const map = (n: WmNode): WmNode => {
    if (n.kind === 'leaf') {
      if (n.id !== leafId) return n
      const fresh: WmNode = { kind: 'leaf', id: newLeafId, buffer: newBuffer }
      return {
        kind: 'split',
        id: `wm:split:${newLeafId}`,
        dir,
        children: position === 'before' ? [fresh, n] : [n, fresh],
        weights: [0.5, 0.5],
      }
    }
    return { ...n, children: n.children.map(map) }
  }
  return map(node)
}

/**
 * Swap the buffer a leaf shows.
 * @param node - tree to transform.
 * @param leafId - leaf to retarget.
 * @param buffer - new buffer kind.
 * @returns the transformed tree (unchanged when `leafId` is absent).
 */
export function setBuffer(node: WmNode, leafId: string, buffer: WmBufferKind): WmNode {
  const map = (n: WmNode): WmNode => {
    if (n.kind === 'leaf') return n.id === leafId ? { ...n, buffer } : n
    return { ...n, children: n.children.map(map) }
  }
  return map(node)
}

/**
 * Write a split's weights (sash drag output).
 * @param node - tree to transform.
 * @param splitId - split whose weights change.
 * @param weights - the new weight list (length must match the split's children).
 * @returns the transformed tree (unchanged when `splitId` is absent).
 */
export function setWeights(node: WmNode, splitId: string, weights: number[]): WmNode {
  const map = (n: WmNode): WmNode => {
    if (n.kind === 'split') {
      if (n.id === splitId) return { ...n, weights }
      return { ...n, children: n.children.map(c => map(c)) }
    }
    return n
  }
  return map(node)
}

/**
 * The first leaf in depth order (the tree's left/top edge) — where the
 * sidebar re-attaches when toggled back on.
 * @param node - tree to walk.
 * @returns the leftmost leaf's id, or undefined for an empty tree.
 */
export function firstLeafId(node: WmNode): string | undefined {
  return leafIds(node)[0]
}

/**
 * The last leaf in depth order (the tree's right/bottom edge) — where the
 * details buffer attaches when opened.
 * @param node - tree to walk.
 * @returns the rightmost leaf's id, or undefined for an empty tree.
 */
export function lastLeafId(node: WmNode): string | undefined {
  const ids = leafIds(node)
  return ids[ids.length - 1]
}

/**
 * Single-window: keep only one leaf, removing every other one (Emacs C-x 1).
 * Removing the target leaf itself is a no-op (the tree always keeps a window).
 * @param node - tree to transform.
 * @param leafId - the leaf to keep.
 * @returns the reduced tree (same reference when nothing else remains).
 */
export function keepOnlyLeaf(node: WmNode, leafId: string): WmNode {
  return leafIds(node).filter(id => id !== leafId).reduce(
    (tree, id) => removeLeaf(tree, id),
    node,
  )
}
