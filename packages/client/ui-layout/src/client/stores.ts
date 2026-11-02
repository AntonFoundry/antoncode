/**
 * The root entry's transient layout store: panel geometry as plain widths in
 * px (0 = closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import {
  clampWidth, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'
import type { MainPanelId } from './service.ts'
import { SINGLETON_BUFFERS as SINGLETONS } from './wm.ts'
import {
  defaultTree, ensureSingletons, migrateLegacyConversation, type WmBuffer, type WmNode,
} from './wm.ts'

/**
 * The frame's viewing mode: 'chat' is the standard per-workspace layout
 * (sidebar + conversation + details, user-arranged splits), 'agent' is the
 * tiled multi-session launcher. Persisted at `dsh.layout.mode`.
 */
export type LayoutMode = 'agent' | 'chat'

const MODE_KEY = 'dsh.layout.mode'

function seedMode(): LayoutMode {
  try {
    const stored = window.localStorage.getItem(MODE_KEY)
    // Migration: the pre-rework default 'agent' IS today's 'chat' (the
    // per-workspace conversation layout).
    // 'code' (the retired terminal-grid mode) folds into 'chat': terminals
    // live in ordinary splits there.
    if (stored === 'chat') return 'chat'
    return 'chat'
  } catch { return 'chat' }
}

/**
 * Layout store state: panel width preferences in px (0 = closed), the
 * narrow-viewport pair — `narrow` mirrors AppFrame's breakpoint reading
 * (viewport < SIDEBAR_AUTO_COLLAPSE) so toggleSidebar can pick semantics, and
 * `narrowExpanded` is the manual override that re-expands the auto-collapsed
 * sidebar over the squeezed center without rewriting the width preference —
 * plus the frame's viewing {@link LayoutMode}.
 */
type LayoutState = {
  sidebar: number
  details: number
  narrow: boolean
  narrowExpanded: boolean
  mode: LayoutMode
  tabbing: boolean
  panelInfo: {
    /** Null selects the Conversation; global panels keep the current Session intact. */
    activePanelId: MainPanelId | null
  }
  /**
   * The `rightbar` occupant's reported presentation. Derived chrome, not a
   * source of truth: the occupant owns whether it is expanded and reports it
   * through `ctx.layout`; the frame shows the details leaf from this report.
   */
  rightbar: RightbarReport
}

/** The `rightbar` occupant's last presentation report. */
export interface RightbarReport {
  /** Whether the right panel is drawn at all. */
  shown: boolean
  /** Whether the normal panel width reserves space beside the centre. */
  track: boolean
  /** Whether the panel covers the frame. */
  fullscreen: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  setMode: (draft: LayoutState, mode: LayoutMode) => void
  toggleTabbing: (draft: LayoutState) => void
  selectPanel: (draft: LayoutState, panelId: MainPanelId | null) => void
  retainMainPanels: (draft: LayoutState, panelIds: readonly string[]) => void
  openRightbar: (draft: LayoutState, track: boolean, fullscreen: boolean) => void
  closeRightbar: (draft: LayoutState) => void
}

/**
 * Create the layout panel store handle. The preference IS the width, so
 * closing a panel forgets its drag width — reopening restores the contract
 * default. Actions are the complete write set: drag writes clamp
 * into the panel's contract range and never cross the open/closed line;
 * open/close transitions write 0 / the default explicitly. Below the
 * auto-collapse breakpoint (AppFrame feeds setNarrow) the sidebar toggle
 * flips the narrowExpanded override instead of the preference.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions>  {
  const handle = defineStore({
    init: (): LayoutState => ({
      sidebar: SIDEBAR_DEFAULT, details: 0, narrow: false, narrowExpanded: false, mode: seedMode(), tabbing: false,
      panelInfo: { activePanelId: null },
      rightbar: { shown: false, track: false, fullscreen: false },
    }),
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) },
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout.
      toggleSidebar: (d) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },
      closeDetails: (d) => { d.details = 0 },
      setMode: (d, mode: LayoutMode) => {
        d.mode = mode
        try { window.localStorage.setItem(MODE_KEY, mode) } catch { /* private mode */ }
      },
      // Tabbing mode (i3-like): directional moves tab the window onto the
      // neighbor instead of swapping with it.
      toggleTabbing: (d) => { d.tabbing = !d.tabbing },
      selectPanel: (d, panelId: MainPanelId | null) => { d.panelInfo.activePanelId = panelId },
      // An unregistered selection falls back to the Conversation.
      retainMainPanels: (d, panelIds: readonly string[]) => {
        if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId)) {
          d.panelInfo.activePanelId = null
        }
      },
      openRightbar: (d, track: boolean, fullscreen: boolean) => { d.rightbar = { shown: true, track, fullscreen } },
      closeRightbar: (d) => { d.rightbar = { shown: false, track: false, fullscreen: false } },
    },
  })
  return handle
}

/**
 * WM store state: the window tree the frame renders plus the runtime focus
 * cursor. Weights, splits and buffers change together through tree transforms
 * (wm.ts); focus is a leaf-id cursor, undefined meaning "first leaf".
 */
export type WmState = {
  tree: WmNode
  focusedLeafId: string | undefined
  /** The buffer registry: singletons always present; scratch/files added on demand. */
  buffers: WmBuffer[]
  /** The pre-expand tree, present while a pane is expanded to full (restore target). */
  preExpandTree: WmNode | undefined
  /**
   * Whether the sidebar leaf's current absence was caused by the
   * narrow-viewport boot auto-drop. The whole tree persists on every write,
   * so the drop's removal persists too and a reload boots from a
   * sidebar-less tree; only the drop sets this (deliberate user closes never
   * do), and every sidebar attach clears it — WmFrame re-attaches on widen
   * when this is true.
   */
  sidebarBootDropped: boolean
}

/**
 * Annotation twin of the wm actions literal (declared return type).
 */
export type WmActions = {
  setTree: (draft: WmState, tree: WmNode) => void
  setFocus: (draft: WmState, leafId: string | undefined) => void
  setBuffers: (draft: WmState, buffers: WmBuffer[]) => void
  /** Heal a pre-registry persisted snapshot: seed the singletons, migrate the legacy conversation buffer. */
  reconcile: (draft: WmState) => void
  /** Enter expanded mode: stash the current tree as the restore target. */
  beginExpand: (draft: WmState, expanded: WmNode) => void
  /** Leave expanded mode: hand back the stashed pre-expand tree. */
  endExpand: (draft: WmState) => void
  /** Record whether the sidebar leaf's absence is a deliberate user close. */
  setSidebarBootDropped: (draft: WmState, dropped: boolean) => void
}

/**
 * Create the window-manager store handle: the persisted window tree
 * (`dsh.layout.wm` in localStorage, whole-value JSON). Seeding is the
 * persistence contract: with no persisted state the instance starts at
 * `defaultTree()` (today's three-buffer layout); a persisted tree
 * rehydrates wholesale.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWmStore(): EngineStoreHandle<WmState, WmActions> {
  return defineStore({
    // focusedLeafId is a runtime cursor: undefined seeds "first leaf of the
    // loaded tree" (WmFrame normalizes), and stale persisted values are
    // normalized away the same way.
    init: (): WmState => ({ tree: defaultTree(), focusedLeafId: undefined, buffers: [...SINGLETONS],
      preExpandTree: undefined, sidebarBootDropped: false }),
    actions: {
      setTree: (d, tree: WmNode) => { d.tree = tree },
      setFocus: (d, leafId: string | undefined) => { d.focusedLeafId = leafId },
      setBuffers: (d, buffers: WmBuffer[]) => { d.buffers = buffers },
      // Reconcile heals BOTH halves: the singleton seed plus the legacy
      // `conversation` → follow-current session-buffer migration (idempotent).
      reconcile: (d) => {
        const migrated = migrateLegacyConversation(ensureSingletons(d.buffers), d.tree)
        d.buffers = migrated.buffers
        d.tree = migrated.tree
      },
      beginExpand: (d, expanded: WmNode) => { d.preExpandTree = d.tree; d.tree = expanded; d.focusedLeafId = undefined },
      endExpand: (d) => {
        if (d.preExpandTree !== undefined) { d.tree = d.preExpandTree; d.preExpandTree = undefined }
        d.focusedLeafId = undefined
      },
      setSidebarBootDropped: (d, dropped: boolean) => { d.sidebarBootDropped = dropped },
    },
    persist: 'dsh.layout.wm',
  })
}

/**
 * Scratch store state: the *scratch* buffer's editable text.
 */
export type ScratchState = { text: string }

/**
 * Annotation twin of the scratch actions literal (declared return type).
 */
export type ScratchActions = { setText: (draft: ScratchState, text: string) => void }

/**
 * Create the scratch-text store handle: persisted at `dsh.wm.scratch`
 * (whole-value JSON). Components debounce their writes; the store itself
 * writes on every update.
 * @returns the store handle.
 */
export function createScratchStore(): EngineStoreHandle<ScratchState, ScratchActions> {
  return defineStore({
    init: (): ScratchState => ({ text: '' }),
    actions: {
      setText: (d, text: string) => { d.text = text },
    },
    persist: 'dsh.wm.scratch',
  })
}
