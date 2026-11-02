/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 * The panel transitions other plugins trigger (sidebar toggle from
 * ui-sidebar, details open/close from ui-conversation) now operate on the
 * window tree: the wm store is authoritative whenever the root entry has
 * attached it (toggleSidebar removes/re-attaches the sidebar leaf,
 * openDetails/closeDetails ensure/remove the details leaf); the legacy
 * layout-store panel actions remain the fallback for unit fakes that only
 * wire `attachPanels`.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'
import { opensInline } from './file-view.ts'
import {
  SIDEBAR_REATTACH_WEIGHT, WM_LEAF_DETAILS, WM_LEAF_SETTINGS, WM_LEAF_SIDEBAR, ensureBuffer, firstLeafId, findLeaf,
  lastLeafId, removeLeaf, splitLeaf, type WmBuffer, type WmNode,
} from './wm.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The wm store face the controller needs: the current tree, buffer registry,
 * and focus cursor for its decisions, and the write actions. The engine store
 * instance satisfies this structurally; tests fake it with a plain object.
 */
export interface WmTreeSource {
  /** Read the current wm snapshot (tree, buffers, and focus included). */
  getSnapshot(): {
    tree: WmNode
    buffers: WmBuffer[]
    focusedLeafId: string | undefined
  }
  /** Subscribe to wm state changes; returns the disposer. */
  subscribe(fn: () => void): () => void
  /** Write a transformed tree, replace the buffer registry, or move the focus. */
  actions: {
    setTree: (tree: WmNode) => void
    setBuffers: (buffers: WmBuffer[]) => void
    setFocus: (leafId: string) => void
    /** Record whether the sidebar leaf's absence came from the narrow auto-drop (persisted). */
    setSidebarBootDropped: (dropped: boolean) => void
  }
}

/**
 * The outward layout face (`ctx.layout`): the panel transitions other
 * plugins may trigger — and exactly what a test fake must supply. The
 * attachPanels/attachWm wiring hooks stay on the concrete class (root-entry
 * assembly only).
 */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
  /** Toggle the details panel (closed ⟷ open). */
  toggleDetails(): void
  /** Open the settings window (no-op when already open). */
  openSettings(): void
  /** Close the settings window. */
  closeSettings(): void
  /** Toggle the settings window (closed ⟷ open). */
  toggleSettings(): void
  /** Whether the settings window leaf currently exists in the wm tree (false before a wm store attaches). */
  settingsOpen(): boolean
  /**
   * Subscribe to settings-window open-state changes; returns the disposer.
   * Forwards the attached wm store's notifications; before attachment the
   * listener never fires and the disposer is a no-op.
   */
  onSettingsOpenChange(listener: () => void): () => void
  /**
   * Open one file path inline: split the focused leaf row-wise into a
   * `buffer:file:<path>` buffer and focus it — the same flow the frame's
   * opener face runs for inline families. Returns `false` when no wm store
   * is attached or the path's family opens with the OS (`opensInline` is
   * false); the caller owns the Host-open fallback then. `true` means the
   * split happened and nothing further is needed.
   */
  openFile(path: string): boolean
}

/** Cross-plugin panel-action face (ctx.layout). */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  #wm: WmTreeSource | undefined

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render; on entry re-register the
   * fresh actions overwrite the stale set.
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
  }

  /**
   * Adopt the root entry's wm store instance. Same inject-hook timing as
   * {@link attachPanels}; once attached, the three panel transitions below
   * become window-tree operations.
   * @param wm - the entry's wm store instance (read + write face).
   */
  attachWm(wm: WmTreeSource): void {
    this.#wm = wm
  }

  /**
   * Toggle the sidebar panel: remove the sidebar leaf when present,
   * otherwise re-attach it as a row split left of the leftmost leaf.
   * Without an attached wm store, falls through to the legacy panel action.
   */
  toggleSidebar(): void {
    if (this.#wm !== undefined) {
      const { tree } = this.#wm.getSnapshot()
      if (findLeaf(tree, WM_LEAF_SIDEBAR) !== undefined) {
        // Deliberate close: leaves the boot-drop marker untouched (a close
        // must stay closed on widen; the narrow auto-drop is the only writer
        // of the marker's true state).
        this.#write(t => removeLeaf(t, WM_LEAF_SIDEBAR))
      } else {
        const anchor = firstLeafId(tree)
        // The re-attached sidebar takes its preferred share, not half the anchor.
        if (anchor !== undefined) {
          this.#write(t => splitLeaf(t, anchor, 'row', 'sidebar', WM_LEAF_SIDEBAR, 'before', [SIDEBAR_REATTACH_WEIGHT, 1 - SIDEBAR_REATTACH_WEIGHT]))
          this.#wm.actions.setSidebarBootDropped(false)
        }
      }
      return
    }
    this.#require().toggleSidebar()
  }

  /**
   * Open the details panel (no-op when open): split the rightmost leaf
   * row-wise into the pinned home details leaf (the context column). Without
   * an attached wm store, falls through to the legacy panel action.
   */
  openDetails(): void {
    if (this.#wm !== undefined) {
      const { tree } = this.#wm.getSnapshot()
      if (findLeaf(tree, WM_LEAF_DETAILS) === undefined) {
        const anchor = lastLeafId(tree)
        if (anchor !== undefined) this.#write(t => splitLeaf(t, anchor, 'row', 'details', WM_LEAF_DETAILS, 'after'))
      }
      return
    }
    this.#require().openDetails()
  }

  /**
   * Close the details panel (no-op when closed): remove the details leaf.
   * Without an attached wm store, falls through to the legacy panel action.
   */
  closeDetails(): void {
    if (this.#wm !== undefined) {
      this.#write(t => findLeaf(t, WM_LEAF_DETAILS) !== undefined ? removeLeaf(t, WM_LEAF_DETAILS) : t)
      return
    }
    this.#require().closeDetails()
  }

  /**
   * Toggle the details panel: close it when open, open it when closed.
   * Without an attached wm store, falls through to the legacy panel actions
   * (open wins when the legacy face cannot answer state queries).
   */
  toggleDetails(): void {
    if (this.#wm !== undefined) {
      const { tree } = this.#wm.getSnapshot()
      if (findLeaf(tree, WM_LEAF_DETAILS) !== undefined) this.closeDetails()
      else this.openDetails()
      return
    }
    this.#require().openDetails()
  }

  /**
   * Open the settings window (no-op when open): split the rightmost leaf
   * row-wise into the canonical settings leaf. Unlike the details column it
   * is a normal weighted pane (no pinned width preference). Without an
   * attached wm store, this is a no-op — the settings shell only exists in
   * compositions that attach the wm store.
   */
  openSettings(): void {
    if (this.#wm === undefined) return
    const { tree } = this.#wm.getSnapshot()
    if (findLeaf(tree, WM_LEAF_SETTINGS) === undefined) {
      const anchor = lastLeafId(tree)
      if (anchor !== undefined) this.#write(t => splitLeaf(t, anchor, 'row', 'settings', WM_LEAF_SETTINGS, 'after'))
    }
  }

  /** Close the settings window (no-op when closed). */
  closeSettings(): void {
    if (this.#wm === undefined) return
    this.#write(t => findLeaf(t, WM_LEAF_SETTINGS) !== undefined ? removeLeaf(t, WM_LEAF_SETTINGS) : t)
  }

  /** Toggle the settings window: close it when open, open it when closed. */
  toggleSettings(): void {
    if (this.#wm === undefined) return
    const { tree } = this.#wm.getSnapshot()
    if (findLeaf(tree, WM_LEAF_SETTINGS) !== undefined) this.closeSettings()
    else this.openSettings()
  }

  /** Whether the settings window leaf currently exists (see {@link ILayout.settingsOpen}). */
  settingsOpen(): boolean {
    const wm = this.#wm
    if (wm === undefined) return false
    return findLeaf(wm.getSnapshot().tree, WM_LEAF_SETTINGS) !== undefined
  }

  /** Forward wm notifications (see {@link ILayout.onSettingsOpenChange}). */
  onSettingsOpenChange(listener: () => void): () => void {
    const wm = this.#wm
    if (wm === undefined) return () => {}
    return wm.subscribe(listener)
  }

  /**
   * Open one file path inline (see {@link ILayout.openFile}). Without an
   * attached wm store this reports `false` — the caller falls back to the
   * Host open, exactly as the frame face did before the face existed.
   */
  openFile(path: string): boolean {
    if (this.#wm === undefined || !opensInline(path)) return false
    const snapshot = this.#wm.getSnapshot()
    const anchor = snapshot.focusedLeafId ?? firstLeafId(snapshot.tree)
    if (anchor === undefined) return false
    const bufferId = `buffer:file:${path}`
    const leafId = `leaf:${bufferId}`
    this.#wm.actions.setBuffers(ensureBuffer(snapshot.buffers, { id: bufferId, kind: 'file', path }))
    this.#wm.actions.setTree(splitLeaf(snapshot.tree, anchor, 'row', bufferId, leafId))
    this.#wm.actions.setFocus(leafId)
    return true
  }

  /** Write one wm tree transform; the caller has checked the attachment. */
  #write(transform: (tree: WmNode) => WmNode): void {
    const wm = this.#wm
    if (wm === undefined) return
    wm.actions.setTree(transform(wm.getSnapshot().tree))
  }

  #require(): PanelActions {
    // Callers are UI gestures, which cannot fire before the root entry
    // rendered (the inject hook runs in its first render) — reaching this
    // unwired is a boot-order bug, not a race to tolerate.
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
