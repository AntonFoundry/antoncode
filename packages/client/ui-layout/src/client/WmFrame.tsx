/**
 * Emacs-style window-manager frame, registered into the built-in 'root' slot
 * (the web shell renders only 'root'). Renders the persisted window tree
 * (wm.ts) as nested flex splits: each leaf is a pane with a slim mode line
 * (buffer name left; split-below / split-right / close buttons right) above
 * its buffer slot, and each sibling pair carries a draggable sash whose
 * pointer drag rewrites the parent split's weights (children min sizes clamp
 * in px, converted through the split's measured size). Chords (keymap.ts)
 * and pane pointerdowns drive the focused leaf; C-x b / C-x w open the
 * minibuffer (Minibuffer.tsx). The frame keeps the phase-1 ports: the
 * session-switch details close, the narrow-viewport sidebar auto-remove
 * (restore only when the loaded tree had it), and the frame-wide
 * 'shell.overlay' floating layer. A fixed brand strip above the tree keeps
 * the Anton brand + sidebar toggle alive even with the workspace leaf
 * closed. Pure component: everything arrives through the four shares.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { BrandWordmark, IconCloseOutline16, IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarOwnerProps } from './index.ts'
import { clampWidth, SIDEBAR_MAX, SIDEBAR_MIN } from './columns.ts'
import type { createLayoutStore, WmState } from './stores.ts'
import { parseChord, type WmCommand } from './keymap.ts'
import { Minibuffer, type MinibufferCandidate } from './Minibuffer.tsx'
import {
  WM_LEAF_SIDEBAR, canClose, findLeaf, findSplit, firstLeafId, keepOnlyLeaf, leafIds, removeLeaf,
  setWeights, splitLeaf, type WmBufferKind, type WmDirection, type WmNode,
} from './wm.ts'
import css from './WmFrame.module.css'

/** Viewport width below which the sidebar leaf auto-removes. */
const SIDEBAR_NARROW = 900

/** Minimum pane widths in px: sidebar clamps tighter than the other buffers. */
const SIDEBAR_PANE_MIN = 200
/** Minimum pane width for non-sidebar panes. */
const PANE_MIN = 240

/** Mode-line buffer titles. */
const BUFFER_TITLES: Record<WmBufferKind, string> = {
  sidebar: 'Workspace',
  conversation: 'Chat',
  details: 'Context',
}

/**
 * Injected share: the renderer-bound wm selector hook, its write callbacks,
 * and the workspace-open resolver (apply closure over ctx.workspaces /
 * ctx.sessions — components never see ctx).
 */
export interface WmFrameInjected {
  /** Selector hook over the wm store snapshot (bound from the inject hooks compartment). */
  useWm: SnapshotSelectorHook<WmState>
  /** Write a transformed tree. */
  setTree: (tree: WmNode) => void
  /** Move the focus cursor (undefined = first leaf). */
  setFocus: (leafId: string | undefined) => void
  /**
   * Open a workspace's most recently updated session; a workspace with no
   * resolvable session falls back to the New Session flow for it.
   */
  openWorkspace: (workspaceId: string) => void
}

/** Full composed props: runtime share + child-slot render share + store share + injected wm face. */
export type WmFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & WmFrameInjected

/** Fresh split-leaf id: page-local counter + random suffix survives tree persistence. */
let leafSeq = 0
function freshLeafId(): string {
  leafSeq += 1
  return `wm:leaf:${leafSeq}:${Math.random().toString(36).slice(2, 8)}`
}

/** Minimum px size of one child subtree of a split (spec: sidebar 200, rest 240). */
function minPxOf(node: WmNode): number {
  return node.kind === 'leaf' && node.buffer === 'sidebar' ? SIDEBAR_PANE_MIN : PANE_MIN
}

/** Split-below mode-line icon: a 16x16 pane outline split by a horizontal line. */
function SplitBelowIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/** Split-right mode-line icon: the same pane outline split by a vertical line. */
function SplitRightIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/**
 * One sash between sibling panes: pointer capture + rAF-throttled axis delta
 * against the drag-start origin (the DragHandle pattern, axis-generalized).
 * `dir` keys the resize cursor; the delta sign always means "the earlier
 * sibling grows".
 */
function Sash(props: {
  dir: WmDirection
  onDragging: (dragging: boolean) => void
  onStart: () => void
  onDelta: (delta: number) => void
}) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = props.dir === 'row' ? e.clientX : e.clientY
    latest.current = origin.current
    callbacks.current.onStart()
    callbacks.current.onDragging(true)
    setDragging(true)
  }, [props.dir])
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = props.dir === 'row' ? e.clientX : e.clientY
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDelta(latest.current - origin.current)
    })
  }, [props.dir])
  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDelta(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onDragging(false)
  }, [])

  return (
    <div
      className={`${css.sash} ${css[props.dir]}`}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** Props threaded through the recursive render. */
interface NodeRenderProps {
  tree: WmNode
  focusedId: string | undefined
  renderSlot: WmFrameProps['renderSlot']
  sidebarOwner: SidebarOwnerProps & { brandInFrame: true }
  onFocus: (leafId: string) => void
  onSplit: (leafId: string, dir: WmDirection) => void
  onClose: (leafId: string) => void
  onSash: (splitId: string, base: SashDragBase) => void
  onDragging: (dragging: boolean) => void
}

/** Frozen gesture base for one sash drag (adjacent weights + split size). */
interface SashDragBase { size: number; index: number; w0: number; w1: number; delta: number }

/**
 * Render one leaf: the pane (mode line + buffer slot). Owner props mirror the
 * AppFrame render site — sidebar receives the layout store's live column
 * state, conversation and details render empty shares. A pointerdown anywhere
 * in the pane moves the focus cursor; the focused pane's mode line highlights.
 */
function LeafPane(props: NodeRenderProps & { node: Extract<WmNode, { kind: 'leaf' }> }) {
  const { node, tree, focusedId, renderSlot, sidebarOwner, onFocus, onSplit, onClose } = props
  const owner = node.buffer === 'sidebar' ? sidebarOwner : {}
  const closeable = canClose(tree, node.id)
  const focused = focusedId === node.id
  return (
    <div className={css.pane} data-buffer={node.buffer} data-focused={focused || undefined} onPointerDown={() => { onFocus(node.id) }}>
      <div className={css.modeLine}>
        <span className={css.bufferName}>{BUFFER_TITLES[node.buffer]}</span>
        <span className={css.modeActions}>
          <button type="button" className={css.modeButton} aria-label="Split below" title="Split below (C-x 2)" onClick={() => { onSplit(node.id, 'column') }}>
            <SplitBelowIcon />
          </button>
          <button type="button" className={css.modeButton} aria-label="Split right" title="Split right (C-x 3)" onClick={() => { onSplit(node.id, 'row') }}>
            <SplitRightIcon />
          </button>
          {closeable && (
            <button type="button" className={css.modeButton} aria-label="Close" title="Close window (C-x 0)" onClick={() => { onClose(node.id) }}>
              <IconCloseOutline16 size={14} />
            </button>
          )}
        </span>
      </div>
      <div className={css.paneBody}>{renderSlot(node.buffer, owner)}</div>
    </div>
  )
}

/**
 * Recursive node renderer: splits lay their children out along `dir` with
 * flex-grow weights, sashes between siblings; the split element's own size
 * converts the pointer delta into a weight fraction at drag time.
 */
function NodeView(props: NodeRenderProps & { node: WmNode }) {
  const { node } = props
  const splitRef = useRef<HTMLDivElement | null>(null)
  const dragBase = useRef<SashDragBase>({ size: 0, index: 0, w0: 0, w1: 0, delta: 0 })
  if (node.kind === 'leaf') return <LeafPane {...props} node={node} />
  return (
    <div
      ref={splitRef}
      className={css.split}
      style={{ flexDirection: node.dir === 'row' ? 'row' : 'column' }}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <Sash
              dir={node.dir}
              onDragging={props.onDragging}
              onStart={() => {
                // Freeze the gesture base: split size and the two adjacent
                // weights at drag start, so deltas never compound (the
                // DragHandle base-width pattern).
                const el = splitRef.current
                dragBase.current = {
                  size: el === null ? 0 : node.dir === 'row' ? el.clientWidth : el.clientHeight,
                  index: i - 1,
                  w0: node.weights[i - 1] ?? 0,
                  w1: node.weights[i] ?? 0,
                  delta: 0,
                }
              }}
              onDelta={(delta) => {
                dragBase.current.delta = delta
                props.onSash(node.id, dragBase.current)
              }}
            />
          )}
          <div
            className={css.paneWrapper}
            style={{ display: 'flex', flexDirection: 'column', flex: `${node.weights[i] ?? 1} 1 0%` }}
          >
            <NodeView {...props} node={child} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

/**
 * The window-manager frame (see module doc).
 * @param props - the four shares plus the injected wm face.
 * @returns the frame element tree.
 */
export function WmFrame({
  useStore,
  useSessions,
  useWorkspaces,
  renderSlot,
  useWm,
  setTree,
  setFocus,
  openWorkspace,
}: WmFrameProps) {
  const panels = useStore(s => s)
  const tree = useWm(s => s.tree)
  const focusedLeafId = useWm(s => s.focusedLeafId)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [dragging, setDragging] = useState(false)
  // Chord prefix + minibuffer prompt are frame-local runtime state (keymap.ts
  // owns the pure parsing; the armed flag is the cross-keypress state here).
  const [prefixArmed, setPrefixArmed] = useState(false)
  const [prompt, setPrompt] = useState<'buffer' | 'workspace' | null>(null)
  const prefixRef = useRef(prefixArmed)
  prefixRef.current = prefixArmed
  const promptRef = useRef(prompt)
  promptRef.current = prompt

  // Normalize the focus cursor: undefined or a stale (removed) leaf id falls
  // back to the first leaf. Effective focus never renders undefined on a
  // non-empty tree.
  const focusedId = useMemo(() => {
    if (focusedLeafId !== undefined && findLeaf(tree, focusedLeafId) !== undefined) return focusedLeafId
    return firstLeafId(tree)
  }, [tree, focusedLeafId])
  const focusRef = useRef(focusedId)
  focusRef.current = focusedId

  // Mirror for callback closures (setTree callbacks read the live tree
  // without re-binding on every render).
  const treeRef = useRef(tree)
  treeRef.current = tree

  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  // Session-switch details close (ported from AppFrame): switching between
  // two real sessions removes the details leaf; a blank or absent selection
  // never triggers it.
  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      const t = treeRef.current
      if (findLeaf(t, 'details') !== undefined) setTree(removeLeaf(t, 'details'))
    }
    lastSession.current = detailsSession
  }, [detailsSession, setTree])

  // Narrow viewports drop the sidebar leaf entirely (simplified port of the
  // AppFrame auto-collapse); re-widening restores it ONLY when the tree this
  // page loaded with had it — a persisted tree without the sidebar stays
  // closed (the user closed it).
  const first = useRef<{ hadSidebar: boolean } | null>(null)
  if (first.current === null) first.current = { hadSidebar: findLeaf(tree, WM_LEAF_SIDEBAR) !== undefined }
  useEffect(() => {
    const t = treeRef.current
    const mounted = first.current
    const has = findLeaf(t, WM_LEAF_SIDEBAR) !== undefined
    if (viewport < SIDEBAR_NARROW && has) {
      setTree(removeLeaf(t, WM_LEAF_SIDEBAR))
    } else if (viewport >= SIDEBAR_NARROW && !has && mounted?.hadSidebar === true) {
      const anchor = firstLeafId(t)
      if (anchor !== undefined) setTree(splitLeaf(t, anchor, 'row', 'sidebar', WM_LEAF_SIDEBAR, 'before'))
    }
    // Runs on viewport transitions; tree is read through the mirror.
  }, [viewport, setTree])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  const onSplit = useCallback((leafId: string, dir: WmDirection) => {
    const t = treeRef.current
    const leaf = findLeaf(t, leafId)
    if (leaf === undefined) return
    // A conversation leaf splits into a details pane: the conversation slot
    // is the single session surface, so it is never duplicated.
    const newBuffer: WmBufferKind = leaf.buffer === 'conversation' ? 'details' : leaf.buffer
    setTree(splitLeaf(t, leafId, dir, newBuffer, freshLeafId()))
  }, [setTree])

  const onClose = useCallback((leafId: string) => {
    const t = treeRef.current
    if (canClose(t, leafId)) setTree(removeLeaf(t, leafId))
  }, [setTree])

  const onSash = useCallback((splitId: string, base: SashDragBase) => {
    const t = treeRef.current
    const split = findSplit(t, splitId)
    if (split === undefined || base.size <= 0) return
    const first = split.children[base.index]
    const second = split.children[base.index + 1]
    if (first === undefined || second === undefined) return
    const total = base.w0 + base.w1
    const min0 = minPxOf(first) / base.size
    const min1 = minPxOf(second) / base.size
    // Absolute from the frozen base: the pointerup flush re-derives the same
    // weights instead of compounding the delta.
    const next0 = Math.min(Math.max(base.w0 + base.delta / base.size, min0), total - min1)
    const next = split.weights.slice()
    next[base.index] = next0
    next[base.index + 1] = total - next0
    setTree(setWeights(t, splitId, next))
  }, [setTree])

  // Brand-strip toggle: the same transition ctx.layout.toggleSidebar() runs
  // (remove the sidebar leaf, or re-attach it left of the leftmost leaf);
  // components cannot reach ctx, so the frame performs the identical tree
  // transform through its own write share.
  const onBrandToggle = useCallback(() => {
    const t = treeRef.current
    if (findLeaf(t, WM_LEAF_SIDEBAR) !== undefined) {
      setTree(removeLeaf(t, WM_LEAF_SIDEBAR))
      return
    }
    const anchor = firstLeafId(t)
    if (anchor !== undefined) setTree(splitLeaf(t, anchor, 'row', 'sidebar', WM_LEAF_SIDEBAR, 'before'))
  }, [setTree])

  // Feed snapshots for the workspace candidates (both are standard seats).
  const workspaceSnapshot = useWorkspaces(s => s)
  const sessionsListSnapshot = useSessions(s => s)

  // Switch-buffer candidates: every buffer kind; an open one focuses its
  // first leaf, a closed one splits into the focused leaf.
  const bufferCandidates = useMemo<MinibufferCandidate[]>(() => {
    const order: WmBufferKind[] = ['sidebar', 'conversation', 'details']
    return order.map((buffer) => {
      const open = leafIds(tree).some(id => findLeaf(tree, id)?.buffer === buffer)
      return { id: `buffer:${buffer}`, label: BUFFER_TITLES[buffer], hint: open ? 'open' : 'new window' }
    })
  }, [tree])

  // Switch-workspace candidates: workspace title + its most recently updated
  // session (from the sessions list summaries) as the hint.
  const workspaceCandidates = useMemo<MinibufferCandidate[]>(() => (
    workspaceSnapshot.items.map((w) => {
      const latest = w.sessionIds
        .map(id => sessionsListSnapshot.byId[id])
        .filter(session => session !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const hint = latest?.displayTitle
      return { id: w.workspaceId, label: w.title, ...(hint === undefined ? {} : { hint }) }
    })
  ), [workspaceSnapshot, sessionsListSnapshot])

  const onMinibufferExecute = useCallback((id: string) => {
    setPrompt(null)
    if (id.startsWith('buffer:')) {
      const buffer = id.slice('buffer:'.length) as WmBufferKind
      const t = treeRef.current
      const existing = leafIds(t).find(leafId => findLeaf(t, leafId)?.buffer === buffer)
      if (existing !== undefined) {
        setFocus(existing)
        return
      }
      const anchor = focusRef.current
      if (anchor === undefined) return
      const newId = freshLeafId()
      setTree(splitLeaf(t, anchor, 'row', buffer, newId))
      setFocus(newId)
      return
    }
    openWorkspace(id)
  }, [openWorkspace, setFocus, setTree])

  // The chord command table, acting on the focused leaf.
  const runCommand = useCallback((command: WmCommand) => {
    switch (command) {
      case 'cancel':
        setPrefixArmed(false)
        setPrompt(null)
        return
      case 'switch-buffer':
        setPrefixArmed(false)
        setPrompt('buffer')
        return
      case 'switch-workspace':
        setPrefixArmed(false)
        setPrompt('workspace')
        return
      case 'split-below':
      case 'split-right': {
        setPrefixArmed(false)
        const id = focusRef.current
        if (id !== undefined) onSplit(id, command === 'split-below' ? 'column' : 'row')
        return
      }
      case 'close':
        setPrefixArmed(false)
        if (focusRef.current !== undefined) onClose(focusRef.current)
        return
      case 'single': {
        setPrefixArmed(false)
        const id = focusRef.current
        if (id !== undefined) setTree(keepOnlyLeaf(treeRef.current, id))
        return
      }
      case 'other-window': {
        setPrefixArmed(false)
        const ids = leafIds(treeRef.current)
        const current = ids.indexOf(focusRef.current ?? '')
        const next = ids[(current + 1) % Math.max(ids.length, 1)]
        if (next !== undefined) setFocus(next)
        return
      }
    }
  }, [onClose, onSplit, setFocus, setTree])

  // Global chord listener: capture phase, installed while mounted. Text
  // fields are never hijacked (input/textarea/contentEditable targets skip
  // the parser, so C-x stays cut in place); while a minibuffer prompt is
  // open only its own keys and the cancel keys respond.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (promptRef.current !== null) {
        // The minibuffer's input owns navigation; bare keys fall through.
        if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'g' || e.key === 'G'))) {
          e.preventDefault()
          runCommand('cancel')
        }
        return
      }
      const result = parseChord(e, prefixRef.current)
      if (result === null) {
        // An unbound key while armed kills the pending chord.
        if (prefixRef.current) setPrefixArmed(false)
        return
      }
      e.preventDefault()
      if ('prefix' in result) {
        setPrefixArmed(true)
        return
      }
      runCommand(result.command)
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [runCommand])

  // The sidebar leaf's owner props keep the layout store's concession state:
  // a 0 preference renders the collapsed rail at its contract width.
  const sidebarOwner: SidebarOwnerProps & { brandInFrame: true } = {
    collapsed: panels.sidebar === 0,
    width: panels.sidebar === 0 ? 56 : clampWidth(panels.sidebar, SIDEBAR_MIN, SIDEBAR_MAX),
    brandInFrame: true,
  }

  const renderProps: NodeRenderProps = {
    tree,
    focusedId,
    renderSlot,
    sidebarOwner,
    onFocus: setFocus,
    onSplit,
    onClose,
    onSash,
    onDragging: setDragging,
  }

  return (
    <div ref={frameRef} className={css.frame} data-dragging={dragging || undefined}>
      <div className={css.brandRow}>
        <BrandWordmark size={30} />
        <button
          type="button"
          className={css.brandToggle}
          aria-label="Toggle workspace sidebar"
          title="Toggle workspace sidebar"
          onClick={onBrandToggle}
        >
          <IconPanelLeftOutline16 size={18} />
        </button>
      </div>
      <div className={css.treeArea}>
        <NodeView {...renderProps} node={tree} />
      </div>
      {prompt !== null && (
        <Minibuffer
          prompt={prompt === 'buffer' ? 'Switch buffer' : 'Switch workspace'}
          candidates={prompt === 'buffer' ? bufferCandidates : workspaceCandidates}
          onExecute={onMinibufferExecute}
          onCancel={() => { setPrompt(null) }}
        />
      )}
      {prefixArmed && <span className={css.prefixIndicator} aria-hidden>C-x-</span>}
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
    </div>
  )
}
