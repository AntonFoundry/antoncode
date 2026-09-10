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

/** The buffer kinds the registry knows. */
export type WmBufferKind = 'sidebar' | 'conversation' | 'details' | 'scratch' | 'files' | 'terminal' | 'file'

/**
 * One registry entry. `path` is present only on `files` buffers (the
 * directory currently listed; navigation replaces it in place). The three
 * shell kinds are singletons — exactly one buffer of each exists, always,
 * and they cannot be killed.
 */
export interface WmBuffer {
  id: string
  kind: WmBufferKind
  path?: string
  /** Present on `terminal` buffers: the interactive PTY session this buffer shows. */
  sessionId?: string
}

/** Stable ids of the three singleton buffers (their ids ARE their kind names). */
export const SINGLETON_BUFFER_IDS: readonly string[] = ['sidebar', 'conversation', 'details']

/** The scratch buffer's fixed id (compos's *scratch*). */
export const SCRATCH_BUFFER_ID = 'buffer:scratch'

/**
 * Weight share the sidebar takes when it re-attaches (toggleSidebar, brand
 * strip, narrow-viewport restore) — the preferred column share, not a 50/50
 * split of the anchor.
 */
export const SIDEBAR_REATTACH_WEIGHT = 0.18

/** The three singleton registry entries, in shell order. */
export const SINGLETON_BUFFERS: readonly WmBuffer[] = [
  { id: 'sidebar', kind: 'sidebar' },
  { id: 'conversation', kind: 'conversation' },
  { id: 'details', kind: 'details' },
]

/** Fresh scratch registry entry. */
export function scratchBuffer(): WmBuffer {
  return { id: SCRATCH_BUFFER_ID, kind: 'scratch' }
}

/**
 * The full buffer roster in shell order: singletons, scratch on demand, then
 * every registered content buffer, deduplicated by id (a reconciled registry
 * already carries the singletons). Candidate lists and the cycle order share
 * this expansion so a new buffer kind is listed automatically — no per-kind
 * whitelist to forget.
 * @param buffers - live registry (wm snapshot).
 * @returns roster entries, registry order after the singletons and scratch.
 */
export function bufferRoster(buffers: readonly WmBuffer[]): WmBuffer[] {
  const roster = [...SINGLETON_BUFFERS.map(b => ({ ...b })), scratchBuffer()]
  for (const buffer of buffers) {
    if (!roster.some(known => known.id === buffer.id)) roster.push(buffer)
  }
  return roster
}

/**
 * Whether a buffer id is one of the unhittable singletons.
 * @param id - buffer id.
 * @returns true for sidebar/conversation/details.
 */
export function isSingletonBuffer(id: string): boolean {
  return SINGLETON_BUFFER_IDS.includes(id)
}

/**
 * Display title of a buffer (mode lines, minibuffer candidate lists).
 * @param buffer - registry entry.
 * @returns Workspace / Chat / Context / *scratch* / `Dired: <path>`.
 */
export function bufferTitle(buffer: WmBuffer): string {
  switch (buffer.kind) {
    case 'sidebar': return 'Workspace'
    case 'conversation': return 'Chat'
    case 'details': return 'Context'
    case 'scratch': return '*scratch*'
    case 'files': return `Dired: ${buffer.path ?? '?'}`
    case 'terminal': return 'Terminal'
    case 'file': return buffer.path ?? '(file)'
  }
}

/**
 * Seed/repair a registry: the three singletons always exist (persisted state
 * from before the registry, or a hand-edited one, heals to this shape).
 * @param buffers - the stored registry (possibly undefined from an old snapshot).
 * @returns the registry with every singleton present, original order preserved.
 */
export function ensureSingletons(buffers: readonly WmBuffer[] | undefined): WmBuffer[] {
  const list = buffers === undefined ? [] : [...buffers]
  for (const singleton of SINGLETON_BUFFERS) {
    if (!list.some(b => b.id === singleton.id)) list.push({ ...singleton })
  }
  return list
}

/**
 * Add a buffer to the registry when absent (open-on-demand).
 * @param buffers - registry.
 * @param buffer - entry to ensure.
 * @returns the registry containing `buffer`.
 */
export function ensureBuffer(buffers: readonly WmBuffer[], buffer: WmBuffer): WmBuffer[] {
  return buffers.some(b => b.id === buffer.id) ? [...buffers] : [...buffers, { ...buffer }]
}

/**
 * Look one registry entry up by id.
 * @param buffers - registry.
 * @param id - buffer id.
 * @returns the entry, or undefined.
 */
export function findBuffer(buffers: readonly WmBuffer[], id: string): WmBuffer | undefined {
  return buffers.find(b => b.id === id)
}

/** A leaf window: shows exactly one buffer (by registry id). */
export interface WmLeaf { kind: 'leaf'; id: string; buffer: string }

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
  // The shipped plan: workspace | chat. Context stays CLOSED — it pops into
  // its own window on demand (the header's context toggle), Emacs-style, and
  // a fresh load never opens with a split the user did not ask for.
  return {
    kind: 'split',
    id: 'wm:root',
    dir: 'row',
    children: [
      { kind: 'leaf', id: WM_LEAF_SIDEBAR, buffer: 'sidebar' },
      { kind: 'leaf', id: WM_LEAF_CONVERSATION, buffer: 'conversation' },
    ],
    weights: [0.2, 0.8],
  }
}

/**
 * Find a leaf by id.
 * @param node - tree to search.
 * @param leafId - leaf id to find.
 * @returns the leaf, or undefined when absent.
 */
/**
 * Pre-order search for the first leaf whose buffer satisfies `predicate`
 * (Chat mode's conversation-focus walk).
 * @param node - subtree root.
 * @param predicate - buffer-kind test over each leaf's buffer id.
 * @returns the first matching leaf, or undefined.
 */
export function findFirstLeaf(node: WmNode, predicate: (bufferId: string) => boolean): WmLeaf | undefined {
  if (node.kind === 'leaf') return predicate(node.buffer) ? node : undefined
  for (const child of node.children) {
    const found = findFirstLeaf(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

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
  // The last window never closes (a tree keeps at least one leaf); every
  // other window does — including the conversation pane (compos: C-x 0 on
  // the chat window is allowed; C-x b brings it back).
  const leaf = findLeaf(node, leafId)
  if (leaf === undefined) return false
  const other = leafIds(node).find(id => id !== leafId)
  return other !== undefined
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
      // Collapse: the surviving child inherits the SPLIT'S whole slot in the
      // parent (the split's total weight), not merely its own share —
      // otherwise a survivor of a details-dominant sibling pair would
      // inherit the tiny conversation share and render as dead space.
      const only = kept[0]
      if (only !== undefined) {
        return { node: only.node, weight: n.weights.reduce((sum, w) => sum + w, 0) }
      }
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
  return normalizeTree(prune(node)?.node ?? node)
}

/**
 * Replace a leaf with a split along `dir` whose children are the old leaf and
 * the new leaf (in that order, unless `position` is 'before'), with equal
 * weights — the Emacs split-below/split-right gesture; 'before' re-attaches
 * a buffer at the anchor's edge (the sidebar toggle's tree-left restore).
 * @param node - tree to transform.
 * @param leafId - leaf to split.
 * @param dir - orientation of the new split.
 * @param newBuffer - buffer id the new leaf shows (must exist in the registry).
 * @param newLeafId - id of the new leaf.
 * @param position - whether the new leaf lands after (default) or before the old leaf.
 * @param weights - optional weights aligned with the children order (default equal).
 * @returns the transformed tree (unchanged when `leafId` is absent).
 */
export function splitLeaf(
  node: WmNode, leafId: string, dir: WmDirection, newBuffer: string, newLeafId: string,
  position: 'after' | 'before' = 'after',
  weights?: [number, number],
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
        weights: weights ?? [0.5, 0.5],
      }
    }
    return { ...n, children: n.children.map(map) }
  }
  return normalizeTree(map(node))
}

/**
 * Swap the buffer a leaf shows.
 * @param node - tree to transform.
 * @param leafId - leaf to retarget.
 * @param bufferId - new buffer id (must exist in the registry).
 * @returns the transformed tree (unchanged when `leafId` is absent).
 */
export function setBuffer(node: WmNode, leafId: string, bufferId: string): WmNode {
  const map = (n: WmNode): WmNode => {
    if (n.kind === 'leaf') return n.id === leafId ? { ...n, buffer: bufferId } : n
    return { ...n, children: n.children.map(map) }
  }
  // Buffer swaps never move weights; normalizeTree still guarantees the
  // sum-1 invariant cheaply (same-reference no-op when already normalized).
  return normalizeTree(map(node))
}

/**
 * Swap the buffer a leaf shows (the registry-era name for {@link setBuffer}).
 * @param node - tree to transform.
 * @param leafId - leaf to retarget.
 * @param bufferId - new buffer id.
 * @returns the transformed tree (unchanged when `leafId` is absent).
 */
export function swapBuffer(node: WmNode, leafId: string, bufferId: string): WmNode {
  return setBuffer(node, leafId, bufferId)
}

/**
 * Open a buffer in a NEW window: split the anchor leaf along `dir` and show
 * the buffer in the new leaf (focused-style split, splitLeaf semantics with
 * the new leaf showing `bufferId`).
 * @param node - tree to transform.
 * @param anchorLeafId - leaf to split.
 * @param dir - orientation of the new split.
 * @param bufferId - buffer the new leaf shows.
 * @param newLeafId - id of the new leaf.
 * @param position - whether the new leaf lands after (default) or before the anchor.
 * @returns the anchor's tree with the new window (unchanged when the anchor is absent).
 */
export function openBuffer(
  node: WmNode, anchorLeafId: string, dir: WmDirection, bufferId: string, newLeafId: string,
  position: 'after' | 'before' = 'after',
): WmNode {
  return splitLeaf(node, anchorLeafId, dir, bufferId, newLeafId, position)
}

/**
 * Kill a buffer: remove it from the registry and swap every leaf showing it
 * to the singleton scratch buffer (created on demand). Killing one of the
 * three singletons is refused — the shell always keeps them.
 * @param state - registry + tree pair.
 * @param bufferId - buffer to kill.
 * @returns the state with the buffer gone (same reference when refused or absent).
 */
export function killBuffer(
  state: { buffers: readonly WmBuffer[]; tree: WmNode },
  bufferId: string,
): { buffers: WmBuffer[]; tree: WmNode } {
  const buffer = findBuffer(state.buffers, bufferId)
  if (buffer === undefined) return { buffers: [...state.buffers], tree: state.tree }
  // Singleton kills re-home their leaves instead of dropping the buffer: the
  // shell always keeps one of each registered (compos: the buffer survives,
  // the window shows something else).
  if (isSingletonBuffer(bufferId)) {
    if (bufferId === 'conversation') return { buffers: [...state.buffers], tree: state.tree }
    if (bufferId === 'details') {
      const map = (n: WmNode): WmNode => {
        if (n.kind === 'leaf') return n.buffer === 'details' ? { ...n, buffer: 'conversation' } : n
        return { ...n, children: n.children.map(map) }
      }
      return { buffers: [...state.buffers], tree: normalizeTree(map(state.tree)) }
    }
    // sidebar: kill = close the workspace leaf (the brand strip restores it).
    const sidebarLeaf = leafIds(state.tree).find(id => findLeaf(state.tree, id)?.buffer === 'sidebar')
    if (sidebarLeaf === undefined || !canClose(state.tree, sidebarLeaf)) {
      return { buffers: [...state.buffers], tree: state.tree }
    }
    return { buffers: [...state.buffers], tree: normalizeTree(removeLeaf(state.tree, sidebarLeaf)) }
  }
  const buffers = ensureBuffer(
    state.buffers.filter(b => b.id !== bufferId),
    scratchBuffer(),
  )
  const map = (n: WmNode): WmNode => {
    if (n.kind === 'leaf') return n.buffer === bufferId ? { ...n, buffer: SCRATCH_BUFFER_ID } : n
    return { ...n, children: n.children.map(map) }
  }
  return { buffers, tree: normalizeTree(map(state.tree)) }
}


/**
 * Renormalize every split's weights to sum exactly 1, recursively (loaded
 * trees can carry drifted weights from older operations; a split whose
 * weights sum to zero or below distributes equally). This is the structural
 * invariant every tree write guarantees — same reference when already
 * normalized.
 * @param node - the tree to normalize.
 * @returns the normalized tree (same reference when nothing changed).
 */
export function normalizeTree(node: WmNode): WmNode {
  if (node.kind === 'leaf') return node
  const total = node.weights.reduce((a, b) => a + b, 0)
  const children = node.children.map(normalizeTree)
  const weights = total > 0
    ? node.weights.map(w => w / total)
    : node.weights.map(() => 1 / Math.max(node.weights.length, 1))
  // Float tolerance: a split whose stored weights are already 1 up to IEEE
  // noise (e.g. 1/641 + 640/641) keeps its reference — rescaling that noise
  // buys nothing and would break the no-op contract.
  const same = node.weights.every((w, i) => {
    const target = weights[i]
    return target !== undefined && Math.abs(w - target) <= 1e-12
  })
    && children.every((c, i) => c === node.children[i])
  return same ? node : { ...node, children, weights }
}

/**
 * Legacy alias of {@link normalizeTree} (the canonical invariant op).
 * @param node - the tree to normalize.
 * @returns the normalized tree.
 */
export function normalizeWeights(node: WmNode): WmNode {
  return normalizeTree(node)
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
/**
 * Balance every split's weights to equal shares, recursively (tidy panes).
 * Pure: returns a new tree; the input is untouched.
 * @param node - subtree root.
 * @returns the balanced tree.
 */
export function tidyTree(node: WmNode): WmNode {
  if (node.kind === 'leaf') return node
  const count = node.children.length
  return {
    ...node,
    weights: node.children.map(() => 1 / count),
    children: node.children.map(tidyTree),
  }
}

/**
 * Swap a leaf with its sibling inside the parent split (flip panes): the
 * leaf takes the sibling's position and weight. A leaf whose parent is the
 * root with no sibling, or an only child, returns the tree unchanged.
 * @param node - subtree root.
 * @param leafId - the leaf to flip.
 * @returns the flipped tree, or the input when no sibling exists.
 */
export function flipWithSibling(node: WmNode, leafId: string): WmNode {
  if (node.kind === 'leaf') return node
  const index = node.children.findIndex(child => child.kind === 'leaf' && child.id === leafId)
  if (index > 0 || (index === 0 && node.children.length > 1)) {
    const siblingIndex = index === 0 ? 1 : index - 1
    const children = node.children.slice()
    const weights = node.weights.slice()
    const moved = node.children[index]
    const sibling = children[siblingIndex]
    if (moved === undefined || sibling === undefined) return node
    children[index] = sibling
    children[siblingIndex] = moved
    const movedWeight = node.weights[index]
    const siblingWeight = weights[siblingIndex]
    if (movedWeight === undefined || siblingWeight === undefined) return node
    weights[index] = siblingWeight
    weights[siblingIndex] = movedWeight
    return { ...node, children, weights }
  }
  return { ...node, children: node.children.map(child => flipWithSibling(child, leafId)) }
}

export function keepOnlyLeaf(node: WmNode, leafId: string): WmNode {
  return normalizeTree(leafIds(node).filter(id => id !== leafId).reduce(
    (tree, id) => removeLeaf(tree, id),
    node,
  ))
}
