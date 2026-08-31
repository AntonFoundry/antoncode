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
import {
  WM_LEAF_DETAILS, WM_LEAF_SIDEBAR, firstLeafId, findLeaf, lastLeafId,
  removeLeaf, splitLeaf, type WmNode,
} from './wm.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The wm store face the controller needs: the current tree for its decisions
 * and the single write action. The engine store instance satisfies this
 * structurally; tests fake it with a plain object.
 */
export interface WmTreeSource {
  /** Read the current wm snapshot (tree included). */
  getSnapshot(): { tree: WmNode }
  /** Write a transformed tree back. */
  actions: { setTree: (tree: WmNode) => void }
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
        this.#write(t => removeLeaf(t, WM_LEAF_SIDEBAR))
      } else {
        const anchor = firstLeafId(tree)
        if (anchor !== undefined) this.#write(t => splitLeaf(t, anchor, 'row', 'sidebar', WM_LEAF_SIDEBAR, 'before'))
      }
      return
    }
    this.#require().toggleSidebar()
  }

  /**
   * Open the details panel (no-op when open): split the rightmost leaf
   * column-wise into a details leaf. Without an attached wm store, falls
   * through to the legacy panel action.
   */
  openDetails(): void {
    if (this.#wm !== undefined) {
      const { tree } = this.#wm.getSnapshot()
      if (findLeaf(tree, WM_LEAF_DETAILS) === undefined) {
        const anchor = lastLeafId(tree)
        if (anchor !== undefined) this.#write(t => splitLeaf(t, anchor, 'column', 'details', WM_LEAF_DETAILS))
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
