/**
 * Live font selection for terminal views: the apply world mirrors the
 * ui-theme `font/change` event into this store; each TerminalView reads it
 * through the hooks compartment (`useTermFont`) and re-fits its xterm on
 * terminal-size changes. Initial size still comes from the boot CSS var, so
 * the store starts untouched.
 * @module @deepseek-ai/dsh-client-ui-terminal/client/term-font
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Terminal-relevant font selection (the sizes a live re-fit consumes). */
export interface TermFontState {
  /** Terminal size in px. */
  termSize: number
  /** Monospace family id (reserved; xterm keeps its Nerd Font stack). */
  monoFont: string
}

/** Annotation twin of the actions literal (declared return type). */
export type TermFontActions = {
  sync: (draft: TermFontState, termSize: number, monoFont: string) => void
}

/**
 * Create the terminal font store handle.
 * @returns the store handle shared by every terminal view.
 */
export function createTermFontStore(): EngineStoreHandle<TermFontState, TermFontActions> {
  return defineStore({
    init: (): TermFontState => {
      // Seed from the boot CSS var so the first render already matches the
      // persisted size; the apply-world listener keeps it current after.
      const raw = typeof document === 'undefined'
        ? ''
        : getComputedStyle(document.documentElement).getPropertyValue('--dsh-font-size-term').trim()
      const parsed = Number.parseInt(raw, 10)
      return { termSize: Number.isFinite(parsed) && parsed > 0 ? parsed : 13, monoFont: 'monaco' }
    },
    actions: {
      sync: (d, termSize: number, monoFont: string) => {
        if (d.termSize === termSize && d.monoFont === monoFont) return
        d.termSize = termSize
        d.monoFont = monoFont
      },
    },
  })
}
