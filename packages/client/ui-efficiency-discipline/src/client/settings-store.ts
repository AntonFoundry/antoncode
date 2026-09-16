/**
 * Efficiency row slot store: mirrors the settings-scope snapshot. The
 * plugin's apply-world scope listener is the only writer; the row component
 * reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Store state mirrored from the persisted preference. */
export interface EfficiencyRowState {
  /** Persisted switch value. */
  enabled: boolean
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

type EfficiencyRowActions = {
  sync: (draft: EfficiencyRowState, enabled: boolean, revision: number) => void
}

/**
 * Declares the efficiency row state and write surface.
 * @returns the store handle.
 */
export function createEfficiencyRowStore(): EngineStoreHandle<EfficiencyRowState, EfficiencyRowActions> {
  return defineStore({
    init: (): EfficiencyRowState => ({ enabled: true, revision: -1 }),
    actions: {
      sync: (d, enabled: boolean, revision: number) => {
        if (revision <= d.revision) return
        d.enabled = enabled
        d.revision = revision
      },
    },
  })
}
