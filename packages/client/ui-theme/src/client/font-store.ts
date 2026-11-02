/**
 * Font row slot store: a mirror of the font service snapshot. The plugin's
 * `font/change` listener is the only writer; the row component reads via
 * props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { FontSelection } from './font-runtime.ts'

/** Store state mirrored from the font snapshot. */
export interface FontRowState extends FontSelection {
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type FontRowActions = {
  sync: (draft: FontRowState, selection: FontSelection, revision: number) => void
}

/**
 * Declares the Font row state and write surface.
 * @returns the store handle.
 */
export function createFontRowStore(): EngineStoreHandle<FontRowState, FontRowActions> {
  return defineStore({
    init: (): FontRowState => ({
      uiFamily: 'system', uiSize: 14, chatSize: 16,
      monoFont: 'monaco', monoSize: 15, termSize: 13,
      revision: -1,
    }),
    actions: {
      sync: (d, selection: FontSelection, revision: number) => {
        if (revision <= d.revision) return
        d.uiFamily = selection.uiFamily
        d.uiSize = selection.uiSize
        d.chatSize = selection.chatSize
        d.monoFont = selection.monoFont
        d.monoSize = selection.monoSize
        d.termSize = selection.termSize
        d.revision = revision
      },
    },
  })
}
