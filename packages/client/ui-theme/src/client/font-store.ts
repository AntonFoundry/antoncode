/**
 * Font row slot store: a mirror of the font service snapshot. The plugin's
 * `font/change` listener is the only writer; the row component reads via
 * props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Store state mirrored from the font snapshot. */
export interface FontRowState {
  /** Curated monospace family id. */
  monoFont: string
  /** Monospace size in px. */
  monoSize: number
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type FontRowActions = {
  sync: (draft: FontRowState, monoFont: string, monoSize: number, revision: number) => void
}

/**
 * Declares the Font row state and write surface.
 * @returns the store handle.
 */
export function createFontRowStore(): EngineStoreHandle<FontRowState, FontRowActions> {
  return defineStore({
    init: (): FontRowState => ({ monoFont: 'monaco', monoSize: 15, revision: -1 }),
    actions: {
      sync: (d, monoFont: string, monoSize: number, revision: number) => {
        if (revision <= d.revision) return
        d.monoFont = monoFont
        d.monoSize = monoSize
        d.revision = revision
      },
    },
  })
}
