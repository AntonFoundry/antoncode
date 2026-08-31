/**
 * Emacs-style window-manager frame, registered into the built-in 'root' slot
 * (the web shell renders only 'root'). Renders the persisted window tree
 * (wm.ts) as nested flex splits: each leaf shows one REGISTRY buffer (mode
 * line title: Workspace / Chat / Context / *scratch* / `Dired: <path>`);
 * sibling pairs carry draggable sashes whose pointer drag rewrites the parent
 * split's weights. Chords (keymap.ts) and pane pointerdowns drive the focused
 * leaf; the minibuffer (Minibuffer.tsx) serves switch-buffer, find-file,
 * kill-buffer, and switch-workspace. Winner mode (C-c ←/→) undoes/redoes
 * structural layout changes — the layout history lives in frame refs (the
 * engine persists whole store snapshots, so runtime-only history cannot ride
 * the store without resurrecting stale layouts across reloads); sash weight
 * drags deliberately skip history. Scratch (*scratch*, ScratchBuffer) and
 * dired-lite files buffers (FilesBuffer) render in-leaf. The frame keeps the
 * earlier ports: the session-switch details close, the narrow-viewport
 * sidebar auto-remove, and the 'shell.overlay' layer. Pure component:
 * everything arrives through the four shares.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import { BrandWordmark, IconCloseOutline16, IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarOwnerProps } from './index.ts'
import { clampWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from './columns.ts'

/** Untouched-preference sidebar share of the frame width (committed baseline). */
const SIDEBAR_SHARE = 0.18
/** Sidebar share ceiling for dragged preferences. */
const SIDEBAR_SHARE_MAX = 0.2
import type { createLayoutStore, ScratchState, WmState } from './stores.ts'
import { COMMANDS, PREFIX_HINTS, parseChord, type ArmedPrefix, type WmCommand } from './keymap.ts'
import { Minibuffer, type MinibufferCandidate } from './Minibuffer.tsx'
import { ScratchBuffer } from './ScratchBuffer.tsx'
import { FilesBuffer } from './FilesBuffer.tsx'
import {
  SINGLETON_BUFFERS, SCRATCH_BUFFER_ID, WM_LEAF_SIDEBAR, bufferTitle, canClose, defaultTree,
  dedupeSingletonBuffers, ensureBuffer, findBuffer, findLeaf, findSplit, firstLeafId,
  isSingletonBuffer, keepOnlyLeaf,
  killBuffer, leafIds, removeLeaf, scratchBuffer, setWeights, splitLeaf, swapBuffer,
  type WmBuffer, type WmDirection, type WmNode,
} from './wm.ts'
import { requestHarnessRestart, waitAndReload } from './bridge.ts'
import css from './WmFrame.module.css'

/** Viewport width below which the sidebar leaf auto-removes. */
const SIDEBAR_NARROW = 900

/** Minimum pane widths in px: sidebar clamps tighter than the other buffers. */
const SIDEBAR_PANE_MIN = 200
/** Minimum pane width for non-sidebar panes. */
const PANE_MIN = 240

/** Winner history cap (window layouts). */
const HISTORY_CAP = 50

/**
 * Injected share: the renderer-bound wm + scratch selector hooks, their write
 * callbacks, and the host/workspace resolvers (apply closures over
 * ctx.workspaces / ctx.sessions — components never see ctx).
 */
export interface WmFrameInjected {
  /** Selector hook over the wm store snapshot (bound from the inject hooks compartment). */
  useWm: SnapshotSelectorHook<WmState>
  /** Selector hook over the scratch-text store (bound from the inject hooks compartment). */
  useScratch: SnapshotSelectorHook<ScratchState>
  /** Write a transformed tree. */
  setTree: (tree: WmNode) => void
  /** Move the focus cursor (undefined = first leaf). */
  setFocus: (leafId: string | undefined) => void
  /** Write the buffer registry. */
  setBuffers: (buffers: WmBuffer[]) => void
  /** Heal a pre-registry persisted snapshot (seed the singleton buffers). */
  reconcileBuffers: () => void
  /** Persist the *scratch* text. */
  writeScratch: (text: string) => void
  /**
   * Open a workspace's most recently updated session; a workspace with no
   * resolvable session falls back to the New Session flow for it.
   */
  openWorkspace: (workspaceId: string) => void
  /** List one directory level (absent path = host home). */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** Open a path with the host OS default application. */
  openPath: (path: string) => Promise<void>
}

/** Full composed props: runtime share + child-slot render share + store share + injected wm face. */
export type WmFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & WmFrameInjected

/** Fresh node id (leaves and files buffers): page counter + random suffix. */
let nodeSeq = 0
function freshId(prefix: string): string {
  nodeSeq += 1
  return `${prefix}:${nodeSeq}:${Math.random().toString(36).slice(2, 8)}`
}
const freshLeafId = (): string => freshId('wm:leaf')
const freshFilesBuffer = (): WmBuffer => ({ id: freshId('buffer:files'), kind: 'files' })

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

/** Scratch body share (the store-backed text + flush tick). */
interface ScratchBufferShared {
  text: string
  onWrite: (text: string) => void
  flushTick: number
}

/** Files body share (host listing face + registry navigation/kill). */
interface FilesBufferShared {
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  openPath: (path: string) => Promise<void>
  onNavigate: (bufferId: string, path: string | undefined) => void
  onKill: (bufferId: string) => void
}

/** Props threaded through the recursive render. */
interface NodeRenderProps {
  tree: WmNode
  focusedId: string | undefined
  buffers: readonly WmBuffer[]
  renderSlot: WmFrameProps['renderSlot']
  sidebarOwner: SidebarOwnerProps & { brandInFrame: true }
  scratch: ScratchBufferShared
  files: FilesBufferShared
  onFocus: (leafId: string) => void
  onSplit: (leafId: string, dir: WmDirection) => void
  onClose: (leafId: string) => void
  onSash: (splitId: string, base: SashDragBase) => void
  onDragging: (dragging: boolean) => void
}

/** Frozen gesture base for one sash drag (adjacent weights + split size). */
interface SashDragBase {
  size: number
  index: number
  w0: number
  w1: number
  delta: number
  /** When the boundary touches the sidebar leaf: its side (index) and px width. */
  sidebar: { index: number; width: number } | null
}

/**
 * Render one leaf: the pane (mode line + buffer body). The registry entry
 * decides the body: the three shell slots render at the frame's render site
 * (sidebar receives the layout store's live column state), scratch and files
 * render their own bodies. A pointerdown anywhere in the pane moves the focus
 * cursor; the focused pane's mode line highlights.
 */
function LeafPane(props: NodeRenderProps & { node: Extract<WmNode, { kind: 'leaf' }> }) {
  const { node, tree, focusedId, buffers, renderSlot, sidebarOwner, scratch, files, onFocus, onSplit, onClose } = props
  const buffer = findBuffer(buffers, node.buffer)
  // A leaf referencing a registry gap falls back by id so a hand-edited or
  // partially migrated snapshot still renders the shell.
  const bufferKind = buffer?.kind ?? (isSingletonBuffer(node.buffer) ? node.buffer : 'scratch')
  const owner = bufferKind === 'sidebar' ? sidebarOwner : {}
  const closeable = canClose(tree, node.id)
  const focused = focusedId === node.id
  const body = bufferKind === 'scratch'
    ? <ScratchBuffer text={scratch.text} onWrite={scratch.onWrite} flushTick={scratch.flushTick} />
    : bufferKind === 'files'
      ? (
        <FilesBuffer
          path={buffer?.path}
          listDirectory={files.listDirectory}
          openPath={files.openPath}
          onNavigate={(target) => { files.onNavigate(node.buffer, target) }}
          onKill={() => { files.onKill(node.buffer) }}
        />
      )
      : renderSlot(bufferKind as 'sidebar' | 'conversation' | 'details', owner)
  const title = buffer !== undefined ? bufferTitle(buffer) : '(unnamed)'
  return (
    <div className={css.pane} data-buffer={bufferKind} data-focused={focused || undefined} onPointerDown={() => { onFocus(node.id) }}>
      <div className={css.modeLine}>
        <span className={css.bufferName}>{title}</span>
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
      <div className={css.paneBody}>{body}</div>
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
                const side = child.kind === 'leaf' && child.buffer === 'sidebar'
                  ? { index: i, width: props.sidebarOwner.width }
                  : undefined
                const sidePrev = i > 0 && node.children[i - 1]?.kind === 'leaf'
                  && (node.children[i - 1] as Extract<WmNode, { kind: 'leaf' }>).buffer === 'sidebar'
                  ? { index: i - 1, width: props.sidebarOwner.width }
                  : undefined
                dragBase.current = {
                  size: el === null ? 0 : node.dir === 'row' ? el.clientWidth : el.clientHeight,
                  index: i - 1,
                  w0: node.weights[i - 1] ?? 0,
                  w1: node.weights[i] ?? 0,
                  delta: 0,
                  sidebar: node.dir === 'row' ? (side ?? sidePrev) : null,
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
            style={child.kind === 'leaf' && child.buffer === 'sidebar'
              ? // The sidebar pane IS the sidebar: pinned to the column width,
            // so the divider sits exactly on the sidebar's edge.
              { display: 'flex', flexDirection: 'column', flex: `0 0 ${props.sidebarOwner.width}px` }
              : { display: 'flex', flexDirection: 'column', flex: `${node.weights[i] ?? 1} 1 0%` }}
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
  useScratch,
  setTree,
  setFocus,
  setSidebarWidth,
  setBuffers,
  reconcileBuffers,
  writeScratch,
  openWorkspace,
  listDirectory,
  openPath,
}: WmFrameProps) {
  const panels = useStore(s => s)
  const wmSnapshot = useWm(s => s)
  const tree = wmSnapshot.tree
  // Pre-registry persisted snapshots carry no buffers array: normalize reads
  // until the mount reconcile heals the persisted copy.
  const buffers = useMemo<WmBuffer[]>(() => wmSnapshot.buffers ?? [...SINGLETON_BUFFERS], [wmSnapshot.buffers])
  const focusedLeafId = wmSnapshot.focusedLeafId
  const scratchText = useScratch(s => s.text)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [dragging, setDragging] = useState(false)
  // Chord prefix + minibuffer prompt are frame-local runtime state (keymap.ts
  // owns the pure parsing; the armed prefix is the cross-keypress state).
  const [prefixArmed, setPrefixArmed] = useState<ArmedPrefix>(undefined)
  const [prompt, setPrompt] = useState<'buffer' | 'workspace' | 'find-file' | 'kill-buffer' | 'commands' | null>(null)
  // Restart-in-progress banner: shown while the poll waits for the host.
  const [restarting, setRestarting] = useState(false)
  const [scratchFlushTick, setScratchFlushTick] = useState(0)
  const prefixRef = useRef(prefixArmed)
  prefixRef.current = prefixArmed
  const promptRef = useRef(prompt)
  promptRef.current = prompt

  // Heal a pre-registry persisted snapshot once per instance.
  useEffect(() => { reconcileBuffers() }, [reconcileBuffers])

  // Winner mode history: frame-local refs (runtime only). Sash weight drags
  // skip history — they are geometry tweaks, not layout changes.
  const historyRef = useRef<WmNode[]>([])
  const futureRef = useRef<WmNode[]>([])

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

  /** Structural tree write: pushes the prior layout onto the winner history. */
  const writeTree = useCallback((next: WmNode) => {
    historyRef.current.push(treeRef.current)
    if (historyRef.current.length > HISTORY_CAP) historyRef.current.shift()
    futureRef.current = []
    setTree(next)
  }, [setTree])

  /** Weight-only write (sash drag): no winner-history entry. */
  const writeWeights = useCallback((next: WmNode) => { setTree(next) }, [setTree])

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
      if (findLeaf(t, 'details') !== undefined) writeTree(removeLeaf(t, 'details'))
    }
    lastSession.current = detailsSession
  }, [detailsSession, writeTree])

  // Narrow viewports drop the sidebar leaf entirely (simplified port of the
  // AppFrame auto-collapse); re-widening restores it ONLY when the tree this
  // page loaded with had it — a persisted tree without the sidebar stays
  // closed (the user closed it).
  const first = useRef<{ hadSidebar: boolean } | null>(null)
  useLayoutEffect(() => {
    // Heal a loaded tree: duplicate singleton panes (two Context leaves from
    // an older split rule) collapse to the depth-first one. An effect, not a
    // render-body write: the store update must land after paint commitment.
    const healed = dedupeSingletonBuffers(treeRef.current)
    if (healed !== treeRef.current) setTree(healed)
    first.current = { hadSidebar: findLeaf(treeRef.current, WM_LEAF_SIDEBAR) !== undefined }
    // Once per mount: the loaded tree is the heal subject.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const t = treeRef.current
    const mounted = first.current
    const has = findLeaf(t, WM_LEAF_SIDEBAR) !== undefined
    if (viewport < SIDEBAR_NARROW && has) {
      writeTree(removeLeaf(t, WM_LEAF_SIDEBAR))
    } else if (viewport >= SIDEBAR_NARROW && !has && mounted?.hadSidebar === true) {
      const anchor = firstLeafId(t)
      if (anchor !== undefined) writeTree(splitLeaf(t, anchor, 'row', 'sidebar', WM_LEAF_SIDEBAR, 'before'))
    }
    // Runs on viewport transitions; tree is read through the mirror.
  }, [viewport, writeTree])

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

  /** Registry write for a files buffer's navigate-in-place. */
  const navigateBuffer = useCallback((bufferId: string, target: string | undefined) => {
    setBuffers(buffers.map((b) => {
      if (b.id !== bufferId) return b
      const updated: WmBuffer = { id: b.id, kind: b.kind }
      return target === undefined ? updated : { ...updated, path: target }
    }))
  }, [buffers, setBuffers])

  /** Kill a buffer through the registry op and publish both halves. */
  const killBufferById = useCallback((bufferId: string) => {
    const result = killBuffer({ buffers, tree: treeRef.current }, bufferId)
    setBuffers(result.buffers)
    setTree(result.tree)
  }, [buffers, setBuffers, setTree])

  /** Open a files buffer beside the focused leaf (one listing per buffer). */
  const openFilesBuffer = useCallback((target: string | undefined) => {
    const t = treeRef.current
    const anchor = focusRef.current ?? firstLeafId(t)
    if (anchor === undefined) return
    const fresh = freshFilesBuffer()
    if (target !== undefined) fresh.path = target
    setBuffers(ensureBuffer(buffers, fresh))
    const leafId = freshLeafId()
    writeTree(splitLeaf(t, anchor, 'row', fresh.id, leafId))
    setFocus(leafId)
  }, [buffers, setBuffers, setFocus, writeTree])

  const onSplit = useCallback((leafId: string, dir: WmDirection) => {
    const t = treeRef.current
    const leaf = findLeaf(t, leafId)
    if (leaf === undefined) return
    // A conversation leaf splits into a details pane: the conversation slot
    // is the single session surface, so it is never duplicated — and a
    // details pane already on screen is focused instead of duplicated.
    const newBuffer = leaf.buffer === 'conversation' ? 'details' : leaf.buffer
    if (newBuffer === 'details') {
      const existing = leafIds(t).find(leafId => findLeaf(t, leafId)?.buffer === 'details')
      if (existing !== undefined) { setFocus(existing); return }
    }
    writeTree(splitLeaf(t, leafId, dir, newBuffer, freshLeafId()))
  }, [setFocus, writeTree])

  const onClose = useCallback((leafId: string) => {
    const t = treeRef.current
    if (canClose(t, leafId)) writeTree(removeLeaf(t, leafId))
  }, [writeTree])

  const onSash = useCallback((splitId: string, base: SashDragBase) => {
    // A boundary touching the sidebar leaf resizes the width preference (the
    // pane is pinned to it), not the split weights.
    if (base.sidebar !== null && base.size > 0) {
      const grown = base.sidebar.index === base.index
      const next = base.sidebar.width + (grown ? base.delta : -base.delta)
      setSidebarWidth(clampWidth(Math.round(next), SIDEBAR_MIN, SIDEBAR_MAX))
      return
    }
    const t = treeRef.current
    const split = findSplit(t, splitId)
    if (split === undefined || base.size <= 0) return
    const left = split.children[base.index]
    const right = split.children[base.index + 1]
    if (left === undefined || right === undefined) return
    const total = base.w0 + base.w1
    const min0 = minPxOf(left) / base.size
    const min1 = minPxOf(right) / base.size
    // Absolute from the frozen base: the pointerup flush re-derives the same
    // weights instead of compounding the delta.
    const next0 = Math.min(Math.max(base.w0 + base.delta / base.size, min0), total - min1)
    const next = split.weights.slice()
    next[base.index] = next0
    next[base.index + 1] = total - next0
    writeWeights(setWeights(t, splitId, next))
  }, [setSidebarWidth])

  // Brand-strip toggle: the same transition ctx.layout.toggleSidebar() runs
  // (remove the sidebar leaf, or re-attach it left of the leftmost leaf);
  // components cannot reach ctx, so the frame performs the identical tree
  // transform through its own write share.
  const onBrandToggle = useCallback(() => {
    const t = treeRef.current
    if (findLeaf(t, WM_LEAF_SIDEBAR) !== undefined) {
      writeTree(removeLeaf(t, WM_LEAF_SIDEBAR))
      return
    }
    const anchor = firstLeafId(t)
    if (anchor !== undefined) writeTree(splitLeaf(t, anchor, 'row', 'sidebar', WM_LEAF_SIDEBAR, 'before'))
  }, [writeTree])

  // Feed snapshots for the workspace candidates (both are standard seats).
  const workspaceSnapshot = useWorkspaces(s => s)
  const sessionsListSnapshot = useSessions(s => s)

  // Switch-buffer candidates: the three singletons + scratch + every files
  // buffer in the registry; open buffers hint "open", others "new window".
  const bufferCandidates = useMemo<MinibufferCandidate[]>(() => {
    const openIds = new Set(leafIds(tree).map(id => findLeaf(tree, id)?.buffer))
    const registry = [...SINGLETON_BUFFERS, scratchBuffer(), ...buffers.filter(b => b.kind === 'files')]
    return registry.map(b => ({
      id: b.id,
      label: bufferTitle(b),
      hint: openIds.has(b.id) ? 'open' : 'new window',
    }))
  }, [tree, buffers])

  // Kill-buffer candidates (compos C-x k): the focused leaf's buffer leads
  // the list — Enter with an empty query kills it — then every other buffer
  // a leaf shows. Killing a singleton re-homes its leaves (killBuffer).
  const killCandidates = useMemo<MinibufferCandidate[]>(() => {
    const focused = findLeaf(tree, focusedId)?.buffer
    const shown: string[] = []
    for (const id of leafIds(tree).map(leafId => findLeaf(tree, leafId)?.buffer)) {
      if (id !== undefined && !shown.includes(id)) shown.push(id)
    }
    const ordered = [
      ...(focused !== undefined ? [focused] : []),
      ...shown.filter(id => id !== focused),
    ]
    return ordered.map((id) => {
      const b = findBuffer(buffers, id)
      return { id, label: b !== undefined ? bufferTitle(b) : id, hint: id === focused ? 'current' : undefined }
    })
  }, [tree, buffers, focusedId])

  // Switch-workspace candidates: workspace title + its most recently updated
  // session (from the sessions list summaries) as the hint.
  const workspaceCandidates = useMemo<MinibufferCandidate[]>(() => (
    workspaceSnapshot.items.map((w) => {
      const latest = w.sessionIds
        .map(id => sessionsListSnapshot.byId[id])
        .filter(session => session !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const hint = latest?.displayTitle
      return { id: w.workspaceId as string, label: w.title, ...(hint === undefined ? {} : { hint }) }
    })
  ), [workspaceSnapshot, sessionsListSnapshot])

  // M-x palette candidates: every registered command, its Emacs name, and
  // its binding as the hint. Execution dispatches the id as a command.
  const commandCandidates = useMemo<MinibufferCandidate[]>(() => (
    COMMANDS.map(c => ({ id: c.command, label: c.name, hint: c.keys }))
  ), [])

  const onMinibufferExecute = useCallback((id: string) => {
    // The prompt mirror still holds the prompt kind (setPrompt(null) has not
    // re-rendered yet) — dispatch on it before the strip closes.
    const kind = promptRef.current
    setPrompt(null)
    if (kind === 'commands') {
      runCommandRef.current(id as WmCommand)
      return
    }
    if (kind === 'find-file') {
      openFilesBuffer(id)
      return
    }
    if (kind === 'kill-buffer') {
      killBufferById(id)
      return
    }
    if (kind === 'workspace') {
      openWorkspace(id)
      return
    }
    const t = treeRef.current
    const existing = leafIds(t).find(leafId => findLeaf(t, leafId)?.buffer === id)
    if (existing !== undefined) {
      // The buffer is on screen: jump to its window (the C-x arrows' jump).
      setFocus(existing)
      return
    }
    // Emacs C-x b: the CURRENT window switches to the buffer — never a split.
    const anchor = focusRef.current
    if (anchor === undefined) return
    // Scratch exists once you ask for it (compos: on-demand scratch).
    if (id === SCRATCH_BUFFER_ID) setBuffers(ensureBuffer(buffers, scratchBuffer()))
    writeTree(swapBuffer(t, anchor, id))
    setFocus(anchor)
  }, [buffers, killBufferById, openFilesBuffer, openWorkspace, setBuffers, setFocus, writeTree])

  /** Cycle the focused leaf's buffer through the registry order. */
  const cycleBuffer = useCallback((step: 1 | -1) => {
    const t = treeRef.current
    const anchor = focusRef.current
    if (anchor === undefined) return
    const leaf = findLeaf(t, anchor)
    if (leaf === undefined) return
    const ids = buffers.map(b => b.id)
    const at = ids.indexOf(leaf.buffer)
    const nextId = ids[(at + step + ids.length) % ids.length]
    if (nextId === undefined || nextId === leaf.buffer) return
    writeTree(swapBuffer(t, anchor, nextId))
  }, [buffers, writeTree])

  // The chord command tables, acting on the focused leaf.
  const runCommand = useCallback((command: WmCommand) => {
    setPrefixArmed(undefined)
    switch (command) {
      case 'cancel':
        setPrompt(null)
        restartAbortRef.current?.abort()
        restartAbortRef.current = null
        setRestarting(false)
        return
      case 'switch-buffer':
        setPrompt('buffer')
        return
      case 'm-x':
        setPrompt('commands')
        return
      case 'restart-app': {
        // Fire → wait → reload (bridge.ts). The banner marks the waiting
        // mode; the reload replaces the whole page when the host answers.
        setRestarting(true)
        requestHarnessRestart()
        const controller = new AbortController()
        restartAbortRef.current = controller
        void waitAndReload(controller.signal).then(() => setRestarting(false))
        return
      }
      case 'switch-workspace':
        setPrompt('workspace')
        return
      case 'find-file':
        setPrompt('find-file')
        return
      case 'kill-buffer':
        setPrompt('kill-buffer')
        return
      case 'dired': {
        // The host home directory: list without a path, adopt the answered path.
        void listDirectory(undefined).then((listing) => { openFilesBuffer(listing.path) })
        return
      }
      case 'save-scratch':
        setScratchFlushTick(tick => tick + 1)
        return
      case 'reset-layout':
        writeTree(defaultTree())
        return
      case 'winner-undo': {
        const prev = historyRef.current.pop()
        if (prev === undefined) return
        futureRef.current.push(treeRef.current)
        setTree(prev)
        return
      }
      case 'winner-redo': {
        const next = futureRef.current.pop()
        if (next === undefined) return
        historyRef.current.push(treeRef.current)
        setTree(next)
        return
      }
      case 'previous-buffer':
        cycleBuffer(-1)
        return
      case 'next-buffer':
        cycleBuffer(1)
        return
      case 'split-below':
      case 'split-right': {
        const id = focusRef.current
        if (id !== undefined) onSplit(id, command === 'split-below' ? 'column' : 'row')
        return
      }
      case 'close':
        if (focusRef.current !== undefined) onClose(focusRef.current)
        return
      case 'single': {
        const id = focusRef.current
        if (id !== undefined) writeTree(keepOnlyLeaf(treeRef.current, id))
        return
      }
      case 'other-window': {
        const ids = leafIds(treeRef.current)
        const current = ids.indexOf(focusRef.current ?? '')
        const next = ids[(current + 1) % Math.max(ids.length, 1)]
        if (next !== undefined) setFocus(next)
        return
      }
    }
  }, [cycleBuffer, listDirectory, onClose, onSplit, setFocus, setTree, writeTree])
  // The minibuffer's execute callback precedes this declaration; the mirror
  // lets it dispatch palette picks without a dependency cycle.
  const runCommandRef = useRef(runCommand)
  runCommandRef.current = runCommand
  // An open restart wait aborts when the user cancels (C-g): the page stays.
  const restartAbortRef = useRef<AbortController | null>(null)

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
        if (prefixRef.current !== undefined) setPrefixArmed(undefined)
        return
      }
      e.preventDefault()
      if ('prefix' in result) {
        setPrefixArmed(result.prefix)
        return
      }
      runCommand(result.command)
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true) }
  }, [runCommand])

  // The sidebar leaf's owner props keep the layout store's concession state:
  // a 0 preference renders the collapsed rail at its contract width. The open
  // column is viewport-proportional: an untouched preference takes 18% of the
  // frame; a dragged preference (any other store value) is honored in px but
  // re-clamped into [SIDEBAR_MIN, 20% of the frame], so the column never
  // exceeds a fifth of the window and the buffer area keeps the rest.
  const shareTarget = clampWidth(
    Math.round(viewport * SIDEBAR_SHARE),
    SIDEBAR_MIN,
    Math.max(SIDEBAR_MIN, Math.round(viewport * SIDEBAR_SHARE_MAX)),
  )
  const sidebarOwner: SidebarOwnerProps & { brandInFrame: true } = {
    collapsed: panels.sidebar === 0,
    width:
      panels.sidebar === 0
        ? 56
        : panels.sidebar === SIDEBAR_DEFAULT
          ? shareTarget
          : Math.min(clampWidth(panels.sidebar, SIDEBAR_MIN, SIDEBAR_MAX), shareTarget),
    brandInFrame: true,
  }

  const filesShared: FilesBufferShared = {
    listDirectory,
    openPath,
    onNavigate: navigateBuffer,
    onKill: killBufferById,
  }
  const scratchShared: ScratchBufferShared = {
    text: scratchText,
    onWrite: writeScratch,
    flushTick: scratchFlushTick,
  }
  const renderProps: NodeRenderProps = {
    tree,
    focusedId,
    buffers,
    renderSlot,
    sidebarOwner,
    scratch: scratchShared,
    files: filesShared,
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
          prompt={prompt === 'buffer' ? 'Switch buffer'
            : prompt === 'workspace' ? 'Switch workspace'
              : prompt === 'commands' ? 'M-x'
                : prompt === 'find-file' ? 'Find file'
                  : 'Kill buffer'}
          candidates={prompt === 'buffer' ? bufferCandidates
            : prompt === 'workspace' ? workspaceCandidates
              : prompt === 'commands' ? commandCandidates
                : prompt === 'find-file' ? []
                  : killCandidates}
          freeEntry={prompt === 'find-file'}
          onExecute={onMinibufferExecute}
          onCancel={() => { setPrompt(null) }}
        />
      )}
      {restarting && (
        <div className={css.whichKey} aria-hidden>
          <span className={css.prefixIndicator}>Restarting — waiting for the host…</span>
        </div>
      )}
      {prefixArmed !== undefined && (
        <div className={css.whichKey} aria-hidden>
          <span className={css.prefixIndicator}>{
            prefixArmed === 'x' ? 'C-x-' : 'C-c-'
          }</span>
          <ul className={css.whichKeyList}>
            {PREFIX_HINTS[prefixArmed].map(h => (
              <li key={h.keys}>
                <span className={css.whichKeyKeys}>{h.keys}</span>
                <span className={css.whichKeyLabel}>{h.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
    </div>
  )
}
