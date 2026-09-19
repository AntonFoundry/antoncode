/**
 * Emacs-style window-manager frame, registered into the built-in 'root' slot
 * (the web shell renders only 'root'). Renders the persisted window tree
 * (wm.ts) as nested flex splits: each leaf shows one REGISTRY buffer (mode
 * line title: Workspace / Chat / Context / *scratch* / `Dired: <path>`);
 * sibling pairs carry draggable sashes whose pointer drag rewrites the parent
 * split's weights. Chords (keymap.ts) and pane pointerdowns drive the focused
 * leaf; the minibuffer (Minibuffer.tsx) serves switch-buffer, kill-buffer,
 * switch-workspace, and the M-x palette, docked in the flow directly above the
 * echo area (StatusLine.tsx) — the frame's persistent last row carrying the
 * armed-chord echo, transient command feedback, and the focused buffer.
 * C-x C-f opens the ido find-file prompt (IdoFind.tsx): a live, narrowing
 * listing of the workspace directory; confirming it lands the full dired
 * window. Winner mode (C-c ←/→) undoes/redoes
 * structural layout changes — the layout history lives in frame refs (the
 * engine persists whole store snapshots, so runtime-only history cannot ride
 * the store without resurrecting stale layouts across reloads); sash weight
 * drags deliberately skip history. Scratch (*scratch*, ScratchBuffer) and
 * dired-lite files buffers (FilesBuffer) render in-leaf. Every window's
 * buffer fills its window: only the HOME sidebar pane (the canonical
 * sidebar leaf in a row split) is pinned to the column width preference —
 * every other window sizes by split weights, whatever buffer it shows. The
 * frame keeps the earlier ports: the session-switch details close, the
 * narrow-viewport sidebar auto-remove, and the 'shell.overlay' layer. Pure
 * component: everything arrives through the four shares.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import { BrandWordmark, IconCloseOutline16, IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarOwnerProps } from './index.ts'
import {
  clampWidth, CONTEXT_DEFAULT, CONTEXT_MAX, CONTEXT_MIN,
  DETAILS_DEFAULT, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/** Untouched-preference sidebar share of the frame width (committed baseline). */
const SIDEBAR_SHARE = 0.18
/** Sidebar share ceiling for dragged preferences. */
const SIDEBAR_SHARE_MAX = 0.2
import type { createLayoutStore, LayoutMode, ScratchState, WmState } from './stores.ts'
import { COMMANDS, PREFIX_HINTS, parseChord, type ArmedPrefix, type WmCommand } from './keymap.ts'
import { Minibuffer, type MinibufferCandidate } from './Minibuffer.tsx'
import { AgentGrid, buildAgentBoard } from './AgentGrid.tsx'
import { FileViewer } from './FileViewer.tsx'
import { IdoFind } from './IdoFind.tsx'
import { StatusLine } from './StatusLine.tsx'
import { ScratchBuffer } from './ScratchBuffer.tsx'
import { FilesBuffer } from './FilesBuffer.tsx'
import {
  SINGLETON_BUFFERS, SCRATCH_BUFFER_ID, WM_LEAF_DETAILS, WM_LEAF_SIDEBAR, bufferRoster, bufferTitle, canClose, defaultTree,
  isSingletonBuffer,
  ensureBuffer, findBuffer, findLeaf, findSplit, firstLeafId, focusDirection, lastLeafId, moveLeafTabbed, normalizeTree,
  tabNeighborLeaf,
  SIDEBAR_REATTACH_WEIGHT,
  toggleTabbed,
  type WmDir,
  flipWithSibling, keepOnlyLeaf, killBuffer, leafIds, removeLeaf, scratchBuffer, setWeights, splitLeaf, swapBuffer, tidyTree,
  type WmBuffer, type WmBufferKind, type WmDirection, type WmNode,
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
  /** Set the frame's viewing mode ('agent' | 'code' | 'chat') and persist it. */
  setMode: (mode: LayoutMode) => void
  /** Heal a pre-registry persisted snapshot (seed the singleton buffers). */
  reconcileBuffers: () => void
  /** Write the sidebar width preference (px) — the pinned sidebar pane resizes through it. */
  setSidebarWidth: (px: number) => void
  /** Persist the *scratch* text. */
  writeScratch: (text: string) => void
  /**
   * Open a workspace's most recently updated session; a workspace with no
   * resolvable session falls back to the New Session flow for it.
   */
  openWorkspace: (workspaceId: string) => void
  openSession: (sessionId: string) => void
  /** Interrupt one session's active turn by id (the board pane stop button). */
  interruptSession: (sessionId: string) => void
  /** Prompt one session by id (the board pane composer); steer while running. */
  promptSession: (sessionId: string, text: string, mode: 'queue' | 'steer') => void
  /** Fetch one session's activity tail lines (undefined when unavailable).
   *  `depth: 'cli'` asks for the taller raw-style transcript. */
  fetchSessionTail: (sessionId: string, depth?: 'brief' | 'cli') => Promise<readonly { kind: 'user' | 'tool' | 'assistant' | 'error'; label: string }[] | undefined>
  /** Fetch one session's current model route (`provider/model`; undefined when
   *  unavailable or unrouted) — the pane strip's swarm visibility. */
  fetchSessionModel: (sessionId: string) => Promise<string | undefined>
  /** Read one text file inline (the file-viewer buffer's body). */
  readTextFile: (path: string) => Promise<{ content: string; truncated: boolean } | undefined>
  /** The frame's theme palette (compos load-theme's candidates). */
  themeList: () => { id: string; colorScheme: string }[]
  /** Load one palette theme by id and persist the choice. */
  loadTheme: (id: string) => void
  /** List one directory level (absent path = host home). */
  listDirectory: (path?: string, opts?: { includeFiles?: boolean }, signal?: AbortSignal) => Promise<DirectoryListing>
  /** Open a path with the host OS default application. */
  openPath: (path: string) => Promise<void>
  /** Dispose one background terminal PTY session when its buffer is killed. */
  disposeTerminalSession?: (sessionId: string) => Promise<void>
}

/** Full composed props: runtime share + child-slot render share + store share + injected wm face. */
export type WmFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'settings.view' | 'shell.overlay' | 'terminal.view' | 'shell.topbar.left' | 'shell.topbar.right'>
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

/** Agent-board viewing preferences persisted per workspace. */
interface BoardPrefs {
  /** Pane order within a section: newest first, or active panes first. */
  sort: 'recent' | 'status'
  /** Minimum pane width driving the auto-fit column count. */
  paneWidth: number
  /** The zoomed pane's session id (tmux-z focus), persisted with the stash. */
  zoomed?: string | undefined
  /** The opened workspace space (Panorama level 2); absent = overview. */
  workspace?: string | undefined
}

/** Minimum px size of one child subtree of a split (spec: sidebar 200, rest 240). */
function minPxOf(node: WmNode): number {
  return (node.kind === 'leaf' && (node.buffer === 'sidebar' || node.buffer === 'details')) ||
    (node.kind === 'split' && (hasLeafBuffer(node, 'sidebar') || hasLeafBuffer(node, 'details')))
    ? SIDEBAR_PANE_MIN
    : PANE_MIN
}

/** Whether a subtree contains any leaf displaying the given buffer. */
function hasLeafBuffer(node: WmNode, buffer: WmBufferKind): boolean {
  if (node.kind === 'leaf') return node.buffer === buffer
  return node.children.some(child => hasLeafBuffer(child, buffer))
}

/**
 * Whether one split child represents the workspace sidebar in a row split:
 * either a standalone leaf displaying the sidebar buffer, or a column-split
 * container containing the sidebar alongside stacked tools (but not conversation).
 */
function isSidebarPane(child: WmNode, dir: WmDirection): boolean {
  if (dir !== 'row') return false
  if (child.kind === 'leaf') return child.buffer === 'sidebar'
  return child.dir === 'column' && hasLeafBuffer(child, 'sidebar') && !hasLeafBuffer(child, 'conversation')
}

/**
 * Whether one split child represents the c0ntext sidebar in a row split:
 * either a standalone leaf displaying the details (Context) buffer, or a column-split
 * container containing Context alongside stacked tools (like terminal, but not conversation).
 */
function isContextPane(child: WmNode, dir: WmDirection): boolean {
  if (dir !== 'row') return false
  if (child.kind === 'leaf') return child.buffer === 'details'
  return child.dir === 'column' && hasLeafBuffer(child, 'details') && !hasLeafBuffer(child, 'conversation')
}

/** Determine the sidebar kind of a child in a row split, if any. */
function paneSidebarKind(child: WmNode, dir: WmDirection): 'sidebar' | 'context' | undefined {
  if (dir !== 'row') return undefined
  if (isSidebarPane(child, dir)) return 'sidebar'
  if (isContextPane(child, dir)) return 'context'
  return undefined
}

/** Directional move icon: a chevron pointing at the travel direction. */
function MoveIcon({ dir }: { dir: 'left' | 'right' | 'up' | 'down' }) {
  const rotation = dir === 'left' ? 0 : dir === 'right' ? 180 : dir === 'up' ? 90 : 270
  return (
    <svg
      viewBox="0 0 16 16" width={18} height={18} aria-hidden
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" width={18} height={18} aria-hidden>
      <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 16 16" width={18} height={18} aria-hidden>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.5 2.5V6h3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function TidyIcon() {
  return (
    <svg viewBox="0 0 16 16" width={18} height={18} aria-hidden>
      <rect x="2" y="2" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8.5" y="2" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2" y="8.5" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/** Exported for sibling shells; the c0ntext toggle plugin inlines its own copy. */
export function ContextIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden>
      <rect x="1" y="2" width="14" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <line x1="10.5" y1="2" x2="10.5" y2="14" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
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
  listDirectory: (path?: string, opts?: { includeFiles?: boolean }, signal?: AbortSignal) => Promise<DirectoryListing>
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
  /** The pinned home context pane's px width (the details width preference). */
  contextWidth: number
  /** The leaf the moving leaf tabbed onto (the drop-shade flash target). */
  tabShade?: string | undefined
  scratch: ScratchBufferShared
  files: FilesBufferShared
  readTextFile: WmFrameProps['readTextFile']
  onFocus: (leafId: string) => void
  onSplit: (leafId: string, dir: WmDirection) => void
  onClose: (leafId: string) => void
  onFlip: (leafId: string) => void
  /** Move one leaf one step in a screen direction (i3-style). */
  onMove: (leafId: string, dir: WmDir) => void
  onToggleExpand: () => void
  expanded: boolean
  onTidy: () => void
  onSash: (splitId: string, base: SashDragBase) => void
  onDragging: (dragging: boolean) => void
  workspacePath?: string | undefined
  onTerminalSessionCreated?: (bufferId: string, sessionId: string) => void
}

/** Frozen gesture base for one sash drag (adjacent weights + split size). */
interface SashDragBase {
  size: number
  index: number
  w0: number
  w1: number
  delta: number
  /** When the boundary touches a pinned home pane (sidebar or context): its
   *  side (index), px width, and which preference the drag writes. */
  sidebar: { index: number; width: number; kind: 'sidebar' | 'context' } | null
}

/**
 * Render one leaf: the pane (mode line + buffer body). The registry entry
 * decides the body: the three shell slots render at the frame's render site
 * (sidebar receives the layout store's live column state), scratch and files
 * render their own bodies. A pointerdown anywhere in the pane moves the focus
 * cursor; the focused pane's mode line highlights.
 */
function LeafPane(props: NodeRenderProps & { node: Extract<WmNode, { kind: 'leaf' }> }) {
  const {
    node, tree, focusedId, buffers, renderSlot, sidebarOwner, scratch, files, readTextFile,
    onFocus, onSplit, onClose, onMove, onToggleExpand, expanded, onTidy, workspacePath, onTerminalSessionCreated,
  } = props
  const buffer = findBuffer(buffers, node.buffer)
  // A leaf referencing a registry gap falls back by id so a hand-edited or
  // partially migrated snapshot still renders the shell.
  const bufferKind: WmBufferKind = buffer?.kind ?? (isSingletonBuffer(node.buffer) ? node.buffer as WmBufferKind : 'scratch')
  const owner = bufferKind === 'sidebar' ? sidebarOwner : {}
  const closeable = canClose(tree, node.id)
  const focused = focusedId === node.id
  const body = bufferKind === 'scratch'
    ? <ScratchBuffer text={scratch.text} onWrite={scratch.onWrite} flushTick={scratch.flushTick} />
    : bufferKind === 'files'
      ? (
        <FilesBuffer
          path={buffer?.path}
          active={focused}
          listDirectory={files.listDirectory}
          openPath={files.openPath}
          onNavigate={(target) => { files.onNavigate(node.buffer, target) }}
          onKill={() => { files.onKill(node.buffer) }}
        />
      )
      : bufferKind === 'file'
        ? <FileViewer path={buffer?.path ?? node.buffer} readText={readTextFile} />
        : bufferKind === 'terminal'
          ? renderSlot('terminal.view', {
            sessionId: buffer?.sessionId,
            workspacePath,
            onSessionCreated: (sessionId) => { onTerminalSessionCreated?.(node.buffer, sessionId) },
          })
          : bufferKind === 'settings'
            ? renderSlot('settings.view', {})
            : renderSlot(bufferKind as 'sidebar' | 'conversation' | 'details', owner)
  // The title uses the same id-based fallback as the kind: a registry gap
  // (stale snapshot before reconcile) still names singleton leaves.
  const title = buffer !== undefined ? bufferTitle(buffer) : bufferTitle({ id: node.buffer, kind: bufferKind })
  // A focused terminal buffer must receive keyboard input immediately: the
  // xterm capture textarea inside the slot occupant takes DOM focus.
  const paneRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!focused || bufferKind !== 'terminal') return
    const el = paneRef.current?.querySelector('.xterm-helper-textarea') ?? null
    if (el !== null) (el as HTMLElement).focus()
  }, [focused, bufferKind])
  return (
    <div
      ref={paneRef} className={css.pane} data-buffer={bufferKind} data-focused={focused || undefined}
      onPointerDown={() => { onFocus(node.id) }}
    >
      <div className={css.modeLine}>
        <span className={css.bufferName}>{title}</span>
        {/* Tab-drop shade: a brief brand overlay on the pane that absorbed
            the moved window as a new tab. */}
        {props.tabShade === node.id && <div className={css.tabShade} aria-hidden />}
        <span className={css.modeActions}>
          <button
            type="button" className={css.modeButton} aria-label="Split below" title="Split below (C-x 2)"
            onClick={() => { onSplit(node.id, 'column') }}
          >
            <SplitBelowIcon />
          </button>
          <button
            type="button" className={css.modeButton} aria-label="Split right" title="Split right (C-x 3)"
            onClick={() => { onSplit(node.id, 'row') }}
          >
            <SplitRightIcon />
          </button>
          {/* Tidy and expand/restore are single-pane operations (C-x 1 must be
              reachable on the last window, and expand must leave a visible
              restore), so they render unconditionally; only flip and close
              require a sibling leaf. */}
          <button
            type="button" className={css.modeButton} aria-label="Tidy panes" title="Tidy panes (balance all splits)"
            onClick={() => { onTidy() }}
          >
            <TidyIcon />
          </button>
          {/* The four directional moves (i3-style): the pane travels one
              step in the arrow's direction (⌘⇧H/⌘⇧J/⌘⇧K/⌘⇧L). */}
          {(['left', 'right', 'up', 'down'] as const).map(dir => (
            <button
              key={dir}
              type="button" className={css.modeButton} aria-label={`Move pane ${dir}`}
              title={`Move pane ${dir} (⌘⇧${dir === 'left' ? 'H' : dir === 'down' ? 'J' : dir === 'up' ? 'K' : 'L'})`}
              onClick={() => { onMove(node.id, dir) }}
            >
              <MoveIcon dir={dir} />
            </button>
          ))}
          {expanded ? (
            <button
              type="button" className={css.modeButton} aria-label="Restore layout" title="Restore the pre-expand layout"
              onClick={() => { onToggleExpand() }}
            >
              <RestoreIcon />
            </button>
          ) : (
            <button
              type="button" className={css.modeButton} aria-label="Expand pane" title="Expand to full frame (C-x 1)"
              onClick={() => { onToggleExpand() }}
            >
              <ExpandIcon />
            </button>
          )}
          {closeable && (
            <button
              type="button" className={css.modeButton} aria-label="Close" title="Close window (C-x 0)"
              onClick={() => { onClose(node.id) }}
            >
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
  const { node, focusedId, buffers, onFocus } = props
  const splitRef = useRef<HTMLDivElement | null>(null)
  const dragBase = useRef<SashDragBase>({ size: 0, index: 0, w0: 0, w1: 0, delta: 0, sidebar: null })
  if (node.kind === 'leaf') return <LeafPane {...props} node={node} />
  // Tabbed container (i3): a tab strip above exactly one visible child — the
  // focused leaf when it belongs to the group, else the first child. Clicking
  // a tab moves the focus cursor to that leaf (which makes it visible).
  if (node.tabbed === true) {
    const tabIdOf = (child: WmNode): string | undefined =>
      child.kind === 'leaf' ? child.id : firstLeafId(child)
    const firstChild = node.children[0]
    const active = node.children.some(child => tabIdOf(child) === focusedId)
      ? focusedId
      : firstChild !== undefined
        ? tabIdOf(firstChild)
        : undefined
    const titleOf = (child: WmNode): string => {
      const id = tabIdOf(child)
      const leaf = id !== undefined ? findLeaf(node, id) : undefined
      const leafBuffer = leaf !== undefined ? findBuffer(buffers, leaf.buffer) : undefined
      const leafKind: WmBufferKind = leafBuffer?.kind
        ?? (leaf !== undefined && isSingletonBuffer(leaf.buffer) ? leaf.buffer as WmBufferKind : 'scratch')
      return bufferTitle({ id: leaf?.buffer ?? '', kind: leafKind })
    }
    const activeChild = node.children.find(child => tabIdOf(child) === active)
    return (
      <div className={css.tabbed}>
        <div className={css.tabStrip} role="tablist" aria-label="Tabbed group">
          {node.children.map((child) => {
            const id = tabIdOf(child)
            return (
              <button
                key={child.id}
                type="button"
                role="tab"
                className={css.tab}
                aria-selected={id === active || undefined}
                title={titleOf(child)}
                onClick={() => { if (id !== undefined) onFocus(id) }}
              >
                {titleOf(child)}
              </button>
            )
          })}
        </div>
        <div className={css.paneWrapper} style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0%' }}>
          {activeChild !== undefined && <NodeView {...props} node={activeChild} />}
        </div>
      </div>
    )
  }
  // Fill guarantee: unpinned children's weights are renormalized over the
  // split's unpinned weight total, keeping Σgrow at exactly 1 whatever the
  // stored weight ratios.
  // Pinned panes: workspace sidebar (left) and c0ntext sidebar (right) are
  // restricted to fixed sidebar sizes when content windows (conversation,
  // terminal, etc.) exist, allowing content windows to expand.
  // When no content windows exist, panes can expand fully to fill the frame.
  const hasContentWindows = node.children.some(child => paneSidebarKind(child, node.dir) === undefined)
  const pinned: ('sidebar' | 'context' | undefined)[] = node.children.map((child) => {
    const kind = paneSidebarKind(child, node.dir)
    if (kind === undefined) return undefined
    // When content windows exist (chat, etc.), sidebars restrict to their fixed size so content can expand.
    if (hasContentWindows) return kind
    // When no content windows exist ("if nothing else exist in the windows"):
    // A single remaining pane expands fully.
    if (node.children.length === 1) return undefined
    // When both workspace sidebar and context sidebar exist with no content:
    // the workspace sidebar stays at its fixed rail, while context expands fully.
    if (kind === 'sidebar' && node.children.some(c => paneSidebarKind(c, node.dir) === 'context')) {
      return 'sidebar'
    }
    return undefined
  })
  const pinnedWidth = (kind: 'sidebar' | 'context'): number =>
    kind === 'sidebar' ? props.sidebarOwner.width : props.contextWidth
  const pinAt = (index: number): { index: number; width: number; kind: 'sidebar' | 'context' } | undefined => {
    const kind = pinned[index]
    return kind === undefined ? undefined : { index, width: pinnedWidth(kind), kind }
  }
  const unpinnedTotal = node.weights.reduce((sum, w, i) => sum + (pinned[i] !== undefined ? 0 : (w ?? 0)), 0)
  const unpinnedCount = pinned.filter(isPinned => isPinned === undefined).length
  const growOf = (i: number): number => {
    if (pinned[i] !== undefined) return 0
    if (unpinnedTotal <= 0) return 1 / Math.max(unpinnedCount, 1)
    return (node.weights[i] ?? 0) / unpinnedTotal
  }
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
                // DragHandle base-width pattern). A boundary touching a
                // PINNED home pane (sidebar or context) resizes that pane's
                // width preference; a workspace buffer shown in any other
                // window resizes ordinary split weights like every other pane.
                const el = splitRef.current
                const prev = node.children[i - 1]
                const side = pinAt(i)
                const sidePrev = prev !== undefined ? pinAt(i - 1) : undefined
                dragBase.current = {
                  size: el === null ? 0 : node.dir === 'row' ? el.clientWidth : el.clientHeight,
                  index: i - 1,
                  w0: node.weights[i - 1] ?? 0,
                  w1: node.weights[i] ?? 0,
                  delta: 0,
                  sidebar: node.dir === 'row' ? (side ?? sidePrev ?? null) : null,
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
            style={pinAt(i) !== undefined
              ? // A pinned home pane IS its column: pinned to the width
              // preference, so the divider sits exactly on its edge.
              // Every other window (including one switched to the same
              // buffer) carries the renormalized split weight — a fill
              // guarantee for the buffer it shows.
              { display: 'flex', flexDirection: 'column', flex: `0 0 ${pinAt(i)?.width ?? 0}px` }
              : { display: 'flex', flexDirection: 'column', flex: `${growOf(i)} 1 0%` }}
          >
            <NodeView {...props} node={child} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

/**
 * Brand-row right chrome: notification and account placeholder buttons.
 * Layout-owned stand-ins occupying `shell.topbar.right` until ui-jobs and
 * identity contribute real occupants (the slot is the seam).
 */
export function TopbarChrome() {
  return (
    <>
      <button type="button" className={css.brandToggle} aria-label="Notifications" title="Notifications (coming soon)">
        <svg width={18} height={18} viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M8 2a4 4 0 0 0-4 4v3l-1.2 2.1a.5.5 0 0 0 .43.75h9.54a.5.5 0 0 0 .43-.75L12 9V6a4 4 0 0 0-4-4Z" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6.5 12.5a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      <button type="button" className={css.brandToggle} aria-label="Account" title="Account (coming soon)">
        <svg width={18} height={18} viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="6.4" r="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3.8 12.6a4.6 4.6 0 0 1 8.4 0" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
    </>
  )
}

/**
 * Agent mode body: every session of the active workspace as a launcher card
 * (title, recency, current marker). Clicking a card opens that session —
 * the frame's conversation windows then show it. A true N-conversation
 * tiled arrangement needs per-card session contexts (a framework seam that
 * does not exist yet); this grid is the honest first cut.
 */
/**
 * The window-manager frame (see module doc).
 * @param props - the four shares plus the injected wm face.
 * @returns the frame element tree.
 */
export function WmFrame({
  useStore,
  actions,
  useSessions,
  useWorkspaces,
  renderSlot,
  useWm,
  useScratch,
  setTree,
  setFocus,
  setSidebarWidth,
  themeList,
  loadTheme,
  setBuffers,
  setMode,
  reconcileBuffers,
  writeScratch,
  openWorkspace,
  openSession,
  interruptSession,
  promptSession,
  fetchSessionTail,
  fetchSessionModel,
  readTextFile,
  listDirectory,
  openPath,
  disposeTerminalSession,
}: WmFrameProps) {
  const panels = useStore(s => s)
  const wmSnapshot = useWm(s => s)
  const tree = wmSnapshot.tree
  // Pre-registry persisted snapshots carry no buffers array: normalize reads
  // until the mount reconcile heals the persisted copy.
  const buffers = useMemo<WmBuffer[]>(() => wmSnapshot.buffers ?? [...SINGLETON_BUFFERS], [wmSnapshot.buffers])
  const focusedLeafId = wmSnapshot.focusedLeafId
  const scratchText = useScratch(s => s.text)
  const buffersRef = useRef(buffers)
  buffersRef.current = buffers
  const focusedIdRef = useRef(focusedLeafId)
  focusedIdRef.current = focusedLeafId
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [dragging, setDragging] = useState(false)
  // Chord prefix + minibuffer prompt are frame-local runtime state (keymap.ts
  // owns the pure parsing; the armed prefix is the cross-keypress state).
  const [prefixArmed, setPrefixArmed] = useState<ArmedPrefix>(undefined)
  const [prompt, setPrompt] = useState<'buffer' | 'workspace' | 'find-file' | 'kill-buffer' | 'commands' | 'themes' | 'save-layout' | 'restore-layout' | null>(null)
  // Restart-in-progress banner: shown while the poll waits for the host.
  const [restarting, setRestarting] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [scratchFlushTick, setScratchFlushTick] = useState(0)
  // Echo area: transient command feedback, self-expiring back to the resting
  // face (the armed chord echoes through prefixArmed directly, never here).
  const [echo, setEcho] = useState<string | undefined>(undefined)
  const echoTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => { window.clearTimeout(echoTimer.current) }, [])
  const notify = useCallback((text: string) => {
    window.clearTimeout(echoTimer.current)
    setEcho(text)
    echoTimer.current = window.setTimeout(() => { setEcho(undefined) }, 4000)
  }, [])
  // Tab-drop shade: the target pane flashes a brand overlay when a directional
  // move tabs the moved window onto it (the non-drag stand-in for i3's drop
  // highlight). Self-expiring; the timer dies with the frame.
  const [tabShade, setTabShade] = useState<string | undefined>(undefined)
  const tabShadeTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => { window.clearTimeout(tabShadeTimer.current) }, [])
  const flashTabShade = useCallback((leafId: string) => {
    window.clearTimeout(tabShadeTimer.current)
    setTabShade(leafId)
    tabShadeTimer.current = window.setTimeout(() => { setTabShade(undefined) }, 700)
  }, [])
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

  // The echo area's resting face: the focused window's buffer (the registry
  // gap fallback mirrors LeafPane's body resolution so the name always
  // matches what the window shows).
  const focusedTitle = useMemo(() => {
    if (focusedId === undefined) return '(none)'
    const leaf = findLeaf(tree, focusedId)
    if (leaf === undefined) return '(none)'
    const b = findBuffer(buffers, leaf.buffer)
    if (b !== undefined) return bufferTitle(b)
    return isSingletonBuffer(leaf.buffer) ? leaf.buffer : 'scratch'
  }, [tree, buffers, focusedId])

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
    // Heal a loaded tree: renormalize drifted weights. Nothing else — the
    // persisted tree IS the layout (windows are views; a buffer shown in
    // several windows is legitimate and reloads as arranged). An effect, not
    // a render-body write: the store update must land after paint commitment.
    const healed = normalizeTree(treeRef.current)
    if (healed !== treeRef.current) setTree(healed)
    first.current = { hadSidebar: findLeaf(treeRef.current, WM_LEAF_SIDEBAR) !== undefined }
    // Once per mount: the loaded tree is the heal subject.
  }, [])
  useEffect(() => {
    const t = treeRef.current
    const mounted = first.current
    const has = findLeaf(t, WM_LEAF_SIDEBAR) !== undefined
    if (viewport < SIDEBAR_NARROW && has) {
      writeTree(removeLeaf(t, WM_LEAF_SIDEBAR))
    } else if (viewport >= SIDEBAR_NARROW && !has && mounted?.hadSidebar === true) {
      const anchor = firstLeafId(t)
      if (anchor !== undefined) {
        // The re-attached sidebar takes its preferred share, not half the
        // anchor (normalizeTree guarantees the sum).
        writeTree(splitLeaf(t, anchor, 'row', 'sidebar', WM_LEAF_SIDEBAR, 'before', [SIDEBAR_REATTACH_WEIGHT, 1 - SIDEBAR_REATTACH_WEIGHT]))
      }
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
    const buf = findBuffer(buffers, bufferId)
    if (buf?.kind === 'terminal' && buf.sessionId !== undefined) {
      void disposeTerminalSession?.(buf.sessionId)
    }
    const result = killBuffer({ buffers, tree: treeRef.current }, bufferId)
    setBuffers(result.buffers)
    setTree(result.tree)
    notify(`Killed ${bufferId}`)
  }, [buffers, disposeTerminalSession, notify, setBuffers, setTree])

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
    // Emacs C-x 2 / C-x 3: the new window shows the SAME buffer. A buffer
    // is content and a window is a view onto it — singletons clone like any
    // other buffer (two Chat windows are two views of the one session
    // surface; the registry keeps exactly one buffer of each kind).
    writeTree(splitLeaf(t, leafId, dir, leaf.buffer, freshLeafId()))
    notify(dir === 'column' ? 'Split below' : 'Split right')
  }, [notify, writeTree])

  const onClose = useCallback((leafId: string) => {
    const t = treeRef.current
    if (canClose(t, leafId)) {
      writeTree(removeLeaf(t, leafId))
      notify('Closed window')
    } else {
      notify('The last window stands')
    }
  }, [notify, writeTree])

  const onFlip = useCallback((leafId: string) => {
    writeTree(flipWithSibling(treeRef.current, leafId))
    notify('Flipped pane')
  }, [notify, writeTree])

  const onMove = useCallback((leafId: string, dir: WmDir) => {
    // Mode-aware i3 move: in tabbing mode the leaf tabs onto the axis
    // neighbor (shade flash on the target); inside a tabbed container it
    // reorders tabs; otherwise the plain swap / move-out runs.
    const result = moveLeafTabbed(treeRef.current, leafId, dir, panels.tabbing)
    if (result.tree === treeRef.current) {
      notify('Nowhere to move')
      return
    }
    writeTree(result.tree)
    if (result.onto !== undefined) {
      // Keep the absorbing pane visible during the shade flash: the moved
      // window waits as its new tab (⌘hjkl or a tab click reaches it).
      flashTabShade(result.onto)
      setFocus(result.onto)
      notify('Tabbed pane')
    } else {
      // i3 focus discipline: focus follows the moved window, so repeated
      // ⌘⇧hjkl presses keep traveling in the direction.
      setFocus(leafId)
      notify('Moved pane')
    }
  }, [flashTabShade, notify, panels.tabbing, setFocus, writeTree])

  const onTidy = useCallback(() => {
    writeTree(tidyTree(treeRef.current))
    actions.setDetails(CONTEXT_DEFAULT)
    setSidebarWidth(SIDEBAR_DEFAULT)
    notify('Tidied panes')
  }, [actions, notify, setSidebarWidth, writeTree])

  // Tabbed-container toggle (⌘⇧E, i3 $mod+e): the focused leaf's nearest
  // multi-child ancestor flips between a tabbed group and a side-by-side /
  // stacked split.
  const onToggleTabbed = useCallback(() => {
    const id = focusRef.current
    if (id === undefined) return
    const next = toggleTabbed(treeRef.current, id)
    if (next === treeRef.current) {
      notify('No container to tab')
      return
    }
    writeTree(next)
    notify('Tabbed container toggled')
  }, [notify, writeTree])

  // Pre-expand tree stash: component-level (a session-scope gesture, not
  // worth a persisted slot) — restore returns the exact prior orientation.
  const preExpandRef = useRef<WmNode | undefined>(undefined)
  const onToggleExpand = useCallback(() => {
    if (preExpandRef.current !== undefined) {
      const restored = preExpandRef.current
      preExpandRef.current = undefined
      setExpanded(false)
      writeTree(restored)
      notify('Restored layout')
      return
    }
    const id = focusRef.current ?? firstLeafId(treeRef.current)
    if (id === undefined) return
    preExpandRef.current = treeRef.current
    setExpanded(true)
    writeTree(keepOnlyLeaf(treeRef.current, id))
    setFocus(id)
    notify('Expanded pane — the button restores the layout')
  }, [notify, setFocus, writeTree])

  const onSash = useCallback((splitId: string, base: SashDragBase) => {
    // A boundary touching a pinned home pane (sidebar or context) resizes
    // that pane's width preference (the pane is pinned to it), not the
    // split weights.
    if (base.sidebar !== null && base.size > 0) {
      const grown = base.sidebar.index === base.index
      const next = base.sidebar.width + (grown ? base.delta : -base.delta)
      if (base.sidebar.kind === 'context') {
        actions.setDetails(clampWidth(Math.round(next), CONTEXT_MIN, CONTEXT_MAX))
        return
      }
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
  }, [actions, setSidebarWidth])

  // Context toggle: the header's right-hand control pops Context into the
  // pinned home context column beside the rightmost window (the right-hand
  // mirror of the workspace sidebar), or takes it back.
  const onContextToggle = useCallback(() => {
    const t = treeRef.current
    const existing = findLeaf(t, WM_LEAF_DETAILS)
    if (existing !== undefined) {
      writeTree(removeLeaf(t, WM_LEAF_DETAILS))
      return
    }
    const anchor = lastLeafId(t)
    if (anchor === undefined) return
    writeTree(splitLeaf(t, anchor, 'row', 'details', WM_LEAF_DETAILS, 'after'))
    setFocus(WM_LEAF_DETAILS)
  }, [setFocus, writeTree])

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

  // Switch-buffer candidates: the full roster (singletons + scratch + every
  // registered buffer, any kind); open buffers hint "open", others
  // "new window".
  const bufferCandidates = useMemo<MinibufferCandidate[]>(() => {
    const openIds = new Set(leafIds(tree).map(id => findLeaf(tree, id)?.buffer))
    const registry = bufferRoster(buffers)
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
    const focused = focusedId === undefined ? undefined : findLeaf(tree, focusedId)?.buffer
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
      const label = b !== undefined ? bufferTitle(b) : id
      const hint = id === focused ? 'current' : undefined
      return { id, label, ...(hint === undefined ? {} : { hint }) }
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

  // Agent mode board: every workspace as a section, each session a live
  // pane with its subagents nested. Built from plain summaries; AgentGrid
  // owns the rendering.
  const agentBoard = useMemo(() => (
    buildAgentBoard(
      workspaceSnapshot.items.map(w => ({ workspaceId: w.workspaceId as string, title: w.title, sessionIds: w.sessionIds })),
      sessionsListSnapshot.byId,
    )
  ), [workspaceSnapshot.items, sessionsListSnapshot.byId])
  // Agent mode: the active workspace's sessions (the current session's
  // workspace owns the frame's arrangement).
  const activeWorkspaceId = useMemo(() => {
    const current = sessionsListSnapshot.current
    if (current === undefined) return undefined
    return workspaceSnapshot.items.find(w => w.sessionIds.includes(current))?.workspaceId
  }, [workspaceSnapshot.items, sessionsListSnapshot.current])

  const activeWorkspacePath = useMemo(() => {
    const ws = activeWorkspaceId
    return workspaceSnapshot.items.find(w => w.workspaceId === ws)?.path ?? workspaceSnapshot.items[0]?.path
  }, [activeWorkspaceId, workspaceSnapshot.items])

  const onTerminalSessionCreated = useCallback((bufferId: string, sessionId: string) => {
    setBuffers(buffersRef.current.map(b => b.id === bufferId ? { ...b, sessionId } : b))
  }, [setBuffers])

  // Per-workspace arrangements: the window tree (and viewing mode) are
  // workspace facts. Three persistence semantics, all keyed by workspace:
  // (1) mid-workspace edits debounce-save into the workspace's stash, so a
  // refresh restores THAT workspace's latest layout, not the global
  // last-written tree; (2) switching stashes the outgoing snapshot and loads
  // the incoming one; (3) a workspace with no stash gets the clean default
  // (chat + left sidebar + right details), except for the one-time migration
  // which keeps the pre-existing global layout for the first workspace seen.
  const prevWsRef = useRef<string | undefined>(undefined)
  const wsSaveTimerRef = useRef<number | null>(null)
  const modeRef = useRef<LayoutMode>(panels.mode)
  modeRef.current = panels.mode
  const wsLabelRef = useRef<string>('')
  // Agent-board viewing preferences: part of the per-workspace stash, seeded
  // on switch and saved with it. Component state, not the layout store — the
  // board is a mode-local view, not a panel geometry fact.
  const [boardPrefs, setBoardPrefs] = useState<BoardPrefs>(() => ({ sort: 'recent', paneWidth: 340 }))
  // One space per window: `#ws=<workspaceId>` pins the board to that
  // workspace's section (multi-monitor targeting). hashchange follows manual
  // edits and other windows; replaceState clears without re-triggering.
  const readPinned = (): string | undefined => {
    const match = /[#&]ws=([^&]+)/.exec(location.hash)
    return match?.[1]
  }
  const [pinnedWorkspace, setPinnedWorkspace] = useState<string | undefined>(readPinned)
  useEffect(() => {
    const onHash = (): void => { setPinnedWorkspace(readPinned()) }
    window.addEventListener('hashchange', onHash)
    return () => { window.removeEventListener('hashchange', onHash) }
  }, [])
  const boardPrefsRef = useRef(boardPrefs)
  boardPrefsRef.current = boardPrefs
  const stashWs = useCallback((target: string): void => {
    try {
      window.localStorage.setItem(`dsh.layout.wm:${target}`, JSON.stringify({
        tree: treeRef.current,
        buffers: buffersRef.current,
        focusedLeafId: focusedIdRef.current,
        mode: modeRef.current,
        agentBoard: boardPrefsRef.current,
        savedAt: Date.now(),
      }))
    } catch { /* private mode */ }
  }, [])
  useEffect(() => {
    const ws = activeWorkspaceId
    if (ws === undefined) return
    const prev = prevWsRef.current
    if (prev === ws) return
    if (prev !== undefined) stashWs(prev)
    prevWsRef.current = ws
    let parsed: { tree?: WmNode; buffers?: WmBuffer[]; mode?: LayoutMode; agentBoard?: BoardPrefs } | undefined
    try {
      const raw = window.localStorage.getItem(`dsh.layout.wm:${ws}`)
      parsed = raw === null ? undefined : JSON.parse(raw)
    } catch { parsed = undefined }
    if (parsed?.tree === undefined) {
      // One-time migration: the pre-per-workspace global layout belongs to
      // the first workspace seen, not to no workspace at all.
      let migrated = false
      try { migrated = window.localStorage.getItem('dsh.layout.wm:migrated-v2') === '1' } catch { migrated = true }
      if (!migrated) {
        stashWs(ws)
        try { window.localStorage.setItem('dsh.layout.wm:migrated-v2', '1') } catch { /* private mode */ }
      } else {
        // Clean default for a first-visit workspace: chat + sidebar + details.
        setTree(defaultTree())
        setBuffers([...SINGLETON_BUFFERS])
        setMode('chat')
        setBoardPrefs({ sort: 'recent', paneWidth: 340 })
        setFocus(undefined)
        preExpandRef.current = undefined
        setExpanded(false)
      }
    } else {
      setTree(parsed.tree)
      if (parsed.buffers !== undefined) setBuffers(parsed.buffers)
      if (parsed.mode !== undefined) setMode(parsed.mode)
      if (parsed.agentBoard !== undefined) setBoardPrefs(parsed.agentBoard)
      setFocus(undefined)
      preExpandRef.current = undefined
      setExpanded(false)
    }
    const view = workspaceSnapshot.items.find(w => w.workspaceId === ws)
    wsLabelRef.current = view?.title ?? ws
    // Runs on workspace change only; the prev guard makes re-runs no-ops.
  }, [activeWorkspaceId, workspaceSnapshot.items, setTree, setBuffers, setFocus, setMode, stashWs])
  // Mid-workspace edits: debounce-save into the CURRENT workspace's stash, so
  // refresh (not just workspace switches) restores the latest arrangement.
  // Runs after the load effect above; the prev guard there ran first.
  useEffect(() => {
    const ws = activeWorkspaceId
    if (ws === undefined || prevWsRef.current !== ws) return
    if (wsSaveTimerRef.current !== null) window.clearTimeout(wsSaveTimerRef.current)
    wsSaveTimerRef.current = window.setTimeout(() => { stashWs(ws) }, 400)
    return () => {
      if (wsSaveTimerRef.current !== null) window.clearTimeout(wsSaveTimerRef.current)
    }
  }, [tree, buffers, panels.mode, activeWorkspaceId, stashWs])

  // load-theme candidates: the frame palette (compos load-theme), the id as
  // the completion and the color scheme as the hint.
  const themeCandidates = useMemo<MinibufferCandidate[]>(() => (
    themeList().map(t => ({ id: t.id, label: t.id, hint: t.colorScheme }))
  ), [themeList])

  // Layout snapshots: named copies (global, restorable on any workspace) and
  // every workspace's own stash. `dsh.layout.wm:named` maps name -> snapshot.
  const readNamedLayouts = useCallback((): Record<string, { tree?: WmNode; buffers?: WmBuffer[]; mode?: LayoutMode; savedAt?: number }> => {
    try {
      const raw = window.localStorage.getItem('dsh.layout.wm:named')
      type NamedLayouts = Record<string, { tree?: WmNode; buffers?: WmBuffer[]; mode?: LayoutMode; savedAt?: number }>
      const parsed: NamedLayouts = raw === null ? {} : JSON.parse(raw) as NamedLayouts
      return parsed
    } catch { return {} }
  }, [])
  const writeNamedLayout = useCallback((name: string, snapshot: { tree: WmNode; buffers: WmBuffer[]; mode: LayoutMode }): void => {
    try {
      const named = readNamedLayouts()
      named[name] = { ...snapshot, savedAt: Date.now() }
      window.localStorage.setItem('dsh.layout.wm:named', JSON.stringify(named))
    } catch { /* private mode */ }
  }, [readNamedLayouts])
  const readWsStash = useCallback((ws: string): { tree?: WmNode; buffers?: WmBuffer[]; mode?: LayoutMode } | undefined => {
    try {
      const raw = window.localStorage.getItem(`dsh.layout.wm:${ws}`)
      return raw === null ? undefined : JSON.parse(raw) as { tree?: WmNode; buffers?: WmBuffer[]; mode?: LayoutMode }
    } catch { return undefined }
  }, [])
  // restore-layout candidates: named layouts first (workspace-independent),
  // then each workspace's own saved arrangement.
  const layoutRestoreCandidates = useMemo<MinibufferCandidate[]>(() => {
    const named = readNamedLayouts()
    const candidates = Object.entries(named)
      .sort((a, b) => (b[1].savedAt ?? 0) - (a[1].savedAt ?? 0))
      .map(([name, snap]) => ({
        id: `named:${name}`,
        label: name,
        hint: snap.savedAt === undefined ? '' : new Date(snap.savedAt).toLocaleString(),
      }))
    for (const w of workspaceSnapshot.items) {
      const stash = readWsStash(w.workspaceId as string)
      if (stash?.tree !== undefined) {
        candidates.push({ id: `ws:${w.workspaceId}`, label: `${w.title} (workspace)`, hint: stash.mode ?? '' })
      }
    }
    return candidates
  }, [readNamedLayouts, readWsStash, workspaceSnapshot.items])
  // save-layout candidates: existing named copies (an Enter on one overwrites
  // it); a fresh name is free-typed.
  const layoutSaveCandidates = useMemo<MinibufferCandidate[]>(() => (
    Object.entries(readNamedLayouts())
      .sort((a, b) => (b[1].savedAt ?? 0) - (a[1].savedAt ?? 0))
      .map(([name, snap]) => ({
        id: name,
        label: name,
        hint: snap.savedAt === undefined ? '' : new Date(snap.savedAt).toLocaleString(),
      }))
  ), [readNamedLayouts])

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
    if (kind === 'themes') {
      loadTheme(id)
      return
    }
    if (kind === 'save-layout') {
      const name = id.trim() === '' ? (wsLabelRef.current || 'workspace') : id.trim()
      writeNamedLayout(name, { tree: treeRef.current, buffers: buffersRef.current, mode: modeRef.current })
      if (activeWorkspaceId !== undefined) stashWs(activeWorkspaceId)
      notify(`Layout saved as "${name}"`)
      return
    }
    if (kind === 'restore-layout') {
      if (id.startsWith('named:')) {
        const name = id.slice('named:'.length)
        const snap = readNamedLayouts()[name]
        if (snap?.tree !== undefined) {
          setTree(snap.tree)
          if (snap.buffers !== undefined) setBuffers(snap.buffers)
          if (snap.mode !== undefined) setMode(snap.mode)
          setFocus(undefined)
          preExpandRef.current = undefined
          setExpanded(false)
          notify(`Restored layout "${name}"`)
        }
        return
      }
      if (id.startsWith('ws:')) {
        const wsId = id.slice('ws:'.length)
        const snap = readWsStash(wsId)
        if (snap?.tree !== undefined) {
          setTree(snap.tree)
          if (snap.buffers !== undefined) setBuffers(snap.buffers)
          if (snap.mode !== undefined) setMode(snap.mode)
          setFocus(undefined)
          preExpandRef.current = undefined
          setExpanded(false)
          const label = workspaceSnapshot.items.find(w => w.workspaceId === wsId)?.title ?? wsId
          notify(`Restored ${label}'s layout`)
        }
        return
      }
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
    // Emacs C-x b: the CURRENT window switches to the buffer — never a
    // split, and a buffer already on screen clones into this window rather
    // than yanking focus across the frame (windows are views).
    const anchor = focusRef.current
    if (anchor === undefined) return
    // Scratch exists once you ask for it (compos: on-demand scratch).
    if (id === SCRATCH_BUFFER_ID) setBuffers(ensureBuffer(buffers, scratchBuffer()))
    writeTree(swapBuffer(t, anchor, id))
    setFocus(anchor)
  }, [buffers, killBufferById, openFilesBuffer, openWorkspace, setBuffers, setFocus, writeTree])

  /** Cycle the focused leaf's buffer through the registry order. A singleton
    * shown in another leaf is skipped — swapping it here would duplicate the
    * pane (the placement bug C-x arrows used to grow). */
  const cycleBuffer = useCallback((step: 1 | -1) => {
    const t = treeRef.current
    const anchor = focusRef.current
    if (anchor === undefined) return
    const leaf = findLeaf(t, anchor)
    if (leaf === undefined) return
    // Same registry expansion the C-x b candidates use — the FULL order:
    // buffers are content, windows are views, so a buffer shown in another
    // window stays in the cycle (cloning, not skipping).
    const ids = bufferRoster(buffers).map(b => b.id)
    if (ids.length === 0) return
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
        notify('Quit')
        return
      case 'switch-buffer':
        setPrompt('buffer')
        return
      case 'm-x':
        setPrompt('commands')
        return
      case 'load-theme':
        setPrompt('themes')
        return
      case 'dump-layout': {
        // Diagnostics: the persisted tree, pretty-printed into *scratch* and
        // swapped into the focused window so the shape is readable in-app.
        const dump = JSON.stringify(treeRef.current, null, 2)
        writeScratch(dump)
        setBuffers(ensureBuffer(buffers, scratchBuffer()))
        const anchor = focusRef.current ?? firstLeafId(treeRef.current)
        if (anchor !== undefined) {
          writeTree(swapBuffer(treeRef.current, anchor, SCRATCH_BUFFER_ID))
          setFocus(anchor)
        }
        void navigator.clipboard?.writeText?.(dump).catch(() => {})
        notify('Layout dumped to *scratch*')
        return
      }
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
        // The host home directory: list without a path.
        void listDirectory(undefined, { includeFiles: true }).then((listing) => { openFilesBuffer(listing.path) })
        return
      }
      case 'term': {
        // Emacs M-x term: open a terminal buffer in its own window beside
        // the focused one. The buffer starts WITHOUT a session id — the
        // terminal view spawns the PTY itself once fonts have settled, so
        // the shell is born at the true pane size (no startup SIGWINCH,
        // no multi-line-prompt redraw garble). The leaf must reference the
        // registry entry by id — an unregistered id falls back to scratch.
        {
          const t = treeRef.current
          const anchor = focusRef.current ?? firstLeafId(t)
          if (anchor === undefined) return
          const leafId = freshLeafId()
          const bufferId = freshId('buffer:term')
          setBuffers(ensureBuffer(buffers, { id: bufferId, kind: 'terminal' }))
          writeTree(splitLeaf(t, anchor, 'row', bufferId, leafId))
          setFocus(leafId)
        }
        return
      }
      case 'tidy-panes': {
        writeTree(tidyTree(treeRef.current))
        actions.setDetails(CONTEXT_DEFAULT)
        setSidebarWidth(SIDEBAR_DEFAULT)
        notify('Tidied panes')
        return
      }
      case 'flip-pane': {
        const id = focusRef.current
        if (id !== undefined) {
          writeTree(flipWithSibling(treeRef.current, id))
          notify('Flipped pane')
        }
        return
      }
      case 'move-window-left':
      case 'move-window-right':
      case 'move-window-up':
      case 'move-window-down': {
        // The chords ride the same mode-aware move as the mode-line chevrons
        // (tabbing mode tabs onto the neighbor; tabbed containers reorder).
        const id = focusRef.current
        if (id === undefined) return
        onMove(id, command.slice('move-window-'.length) as WmDir)
        return
      }
      case 'focus-left':
      case 'focus-right':
      case 'focus-up':
      case 'focus-down': {
        // i3-style directional focus: the nearest leaf whose center lies in
        // the direction of travel (see focusDirection).
        const id = focusRef.current ?? firstLeafId(treeRef.current)
        if (id === undefined) return
        const dir = command.slice('focus-'.length) as WmDir
        // i3 tabbed-container focus: cycle the tab order within the stack
        // first; at the container's edge fall through to geometric focus.
        const tabNeighbor = tabNeighborLeaf(treeRef.current, id, dir)
        if (tabNeighbor !== undefined) {
          setFocus(tabNeighbor)
          return
        }
        const target = focusDirection(treeRef.current, id, dir)
        if (target !== undefined) setFocus(target)
        return
      }
      case 'toggle-tabbed':
        onToggleTabbed()
        return
      case 'multi-cursor': {
        // The broadcast state lives in ui-terminal's store; the frame only
        // raises the toggle event (same seam as the c0ntext open-map event).
        window.dispatchEvent(new CustomEvent('ui-terminal:toggle-broadcast'))
        return
      }
      case 'restore-layout':
        setPrompt('restore-layout')
        return
      case 'save-layout': {
        // Flush the workspace stash now (the debounced save would land in
        // 400ms), then prompt for an optional named copy.
        if (activeWorkspaceId !== undefined) stashWs(activeWorkspaceId)
        setPrompt('save-layout')
        return
      }
      case 'save-scratch':
        setScratchFlushTick(tick => tick + 1)
        notify('Wrote *scratch*')
        return
      case 'reset-layout':
        writeTree(defaultTree())
        notify('Layout reset')
        return
      case 'winner-undo': {
        const prev = historyRef.current.pop()
        if (prev === undefined) return
        futureRef.current.push(treeRef.current)
        setTree(prev)
        notify('Undo')
        return
      }
      case 'winner-redo': {
        const next = futureRef.current.pop()
        if (next === undefined) return
        historyRef.current.push(treeRef.current)
        setTree(next)
        notify('Redo')
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
        // C-x 1 rides the toggle: expanding stashes the pre-expand tree, so
        // a second C-x 1 (or the header button) restores it.
        onToggleExpandRef.current()
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
  }, [buffers, cycleBuffer, listDirectory, loadTheme, notify, onClose, onMove, onSplit, onToggleTabbed,
    sessionsListSnapshot, setBuffers, setFocus, setTree, writeScratch, writeTree, stashWs, activeWorkspaceId])
  // The minibuffer's execute callback precedes this declaration; the mirror
  // lets it dispatch palette picks without a dependency cycle.
  const runCommandRef = useRef(runCommand)
  runCommandRef.current = runCommand
  const onToggleExpandRef = useRef(onToggleExpand)
  onToggleExpandRef.current = onToggleExpand
  // An open restart wait aborts when the user cancels (C-g): the page stays.
  const restartAbortRef = useRef<AbortController | null>(null)

  // Global chord listener: capture phase, installed while mounted. Chords
  // fire EVERYWHERE — including text fields (Emacs: the keyboard belongs to
  // the command loop; on macOS Ctrl+X has no native meaning in a text field,
  // and while a prefix is armed the following keystroke is consumed, never
  // inserted). Two carve-outs: an open minibuffer/ido prompt owns its own
  // keys (its input handles navigation and cancel), and a bare Escape with
  // nothing armed stays the app's own key (blur/dismiss) — never a chord.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (promptRef.current !== null) {
        // The minibuffer's input owns navigation; bare keys fall through.
        if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'g' || e.key === 'G'))) {
          e.preventDefault()
          runCommand('cancel')
        }
        return
      }
      if (e.key === 'Escape' && prefixRef.current === undefined) return
      // Bare modifier down-strokes (the Control↓ that STARTS the next
      // chord's second keystroke) never touch the armed prefix: real
      // keyboards send them between the two keystrokes of C-x C-f, and
      // treating them as unbound disarmed the prefix mid-chord.
      if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return
      const result = parseChord(e, prefixRef.current)
      if (result === null) {
        // An unbound key while armed kills the pending chord — and is
        // consumed (never inserted into whatever field has focus).
        if (prefixRef.current !== undefined) {
          e.preventDefault()
          setPrefixArmed(undefined)
        }
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

  // The c0ntext sidebar column's px width: starts at CONTEXT_DEFAULT (natural content width 552px)
  // so internal elements fit comfortably with extra breathing room and no horizontal scrollbar.
  // A manually dragged preference is honored in px and clamped into [CONTEXT_MIN, CONTEXT_MAX].
  const contextWidth =
    panels.details === 0 ||
    panels.details === DETAILS_DEFAULT ||
    panels.details === SIDEBAR_DEFAULT ||
    panels.details === SIDEBAR_MIN ||
    panels.details === 384 ||
    panels.details === 460 ||
    panels.details === CONTEXT_DEFAULT
      ? CONTEXT_DEFAULT
      : clampWidth(panels.details, CONTEXT_MIN, CONTEXT_MAX)

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
    contextWidth,
    tabShade,
    scratch: scratchShared,
    files: filesShared,
    readTextFile,
    onFocus: setFocus,
    onSplit,
    onClose,
    onFlip,
    onMove,
    onToggleExpand,
    expanded,
    onTidy,
    onSash,
    onDragging: setDragging,
    workspacePath: activeWorkspacePath,
    onTerminalSessionCreated,
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
        {renderSlot('shell.topbar.left', {})}
        <div className={css.modeSwitch} role="tablist" aria-label="Layout mode">
          {(['agent', 'chat'] as const).map(m => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={panels.mode === m || undefined}
              className={css.modeTab}
              data-active={panels.mode === m || undefined}
              onClick={() => { actions.setMode(m) }}
            >
              {m === 'agent' ? 'Orchestrator' : 'Chat'}
            </button>
          ))}
        </div>
        {/* The right-edge chrome cluster: the context toggle leads the same
            40px button row as the notification/account stand-ins (it used to
            float mid-header after the centered mode switch). */}
        <div className={css.topbarRight}>
          <button
            type="button"
            className={css.brandToggle}
            aria-label="Toggle context panel"
            title="Toggle context panel"
            data-active={findLeaf(tree, WM_LEAF_DETAILS) !== undefined || undefined}
            onClick={onContextToggle}
          >
            <ContextIcon />
          </button>
          {renderSlot('shell.topbar.right', {})}
        </div>
      </div>
      <div className={css.treeArea}>
        {panels.mode === 'agent'
          ? (
            <AgentGrid
              groups={agentBoard}
              sort={boardPrefs.sort}
              paneWidth={boardPrefs.paneWidth}
              zoomed={boardPrefs.zoomed}
              workspace={boardPrefs.workspace}
              pin={pinnedWorkspace}
              onPrefsChange={(next) => { setBoardPrefs(current => ({ ...current, ...next })) }}
              onClearPin={() => { history.replaceState(null, '', location.pathname + location.search) ; setPinnedWorkspace(undefined) }}
              currentSessionId={sessionsListSnapshot.current}
              onOpen={(sessionId) => { openSession(sessionId) }}
              onInterrupt={(sessionId) => { interruptSession(sessionId) }}
              onPrompt={(sessionId, text, mode) => { promptSession(sessionId, text, mode) }}
              fetchTail={fetchSessionTail}
              fetchModel={fetchSessionModel}
            />
          )
          : <NodeView {...renderProps} node={tree} />}
      </div>
      {prompt === 'find-file' && (() => {
        // Emacs C-x C-f over the workspace: the ido prompt seeds at the
        // focused session's directory (its cwd IS the workspace), falling
        // back to the host home.
        const currentId = sessionsListSnapshot.current
        const cwd = currentId === undefined ? undefined : sessionsListSnapshot.byId[currentId]?.cwd
        return (
          <IdoFind
            initialDir={cwd}
            listDirectory={listDirectory}
            onOpen={(dir) => { setPrompt(null); openFilesBuffer(dir) }}
            onCancel={() => { setPrompt(null) }}
          />
        )
      })()}
      {prompt !== null && prompt !== 'find-file' && (
        <Minibuffer
          // Remount per prompt kind: the component owns its query state, and
          // a kind switch must start the new prompt from an empty filter
          // (a stale query filtered the theme list to nothing).
          key={prompt}
          prompt={prompt === 'buffer' ? 'Switch buffer'
            : prompt === 'workspace' ? 'Switch workspace'
              : prompt === 'commands' ? 'M-x'
                : prompt === 'themes' ? 'Load theme'
                  : prompt === 'save-layout' ? 'Save layout as'
                    : prompt === 'restore-layout' ? 'Restore layout'
                      : 'Kill buffer'}
          candidates={prompt === 'buffer' ? bufferCandidates
            : prompt === 'workspace' ? workspaceCandidates
              : prompt === 'commands' ? commandCandidates
                : prompt === 'themes' ? themeCandidates
                  : prompt === 'save-layout' ? layoutSaveCandidates
                    : prompt === 'restore-layout' ? layoutRestoreCandidates
                      : killCandidates}
          onExecute={onMinibufferExecute}
          freeEntry={prompt === 'save-layout'}
          initialQuery={prompt === 'save-layout' ? wsLabelRef.current : ''}
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
          {/* The armed chord itself echoes in the echo area; this popup
              carries only the completions. */}
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
      <StatusLine
        prefix={prefixArmed}
        message={echo}
        bufferTitle={focusedTitle}
        windowCount={leafIds(tree).length}
      />
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
    </div>
  )
}
