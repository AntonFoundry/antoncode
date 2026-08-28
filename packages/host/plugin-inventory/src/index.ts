/** Read-only projection of the current Cordis Loader plugin entries. */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  ConfigScalar,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from './types.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

const PROTECTED_PLUGINS = new Set([
  'cordis:include',
  'cordis:group',
  '@deepseek-ai/cordis-plugin-server',
  '@deepseek-ai/dsh-client-connection',
])

/** Project the JSON-scalar subset of an entry's config for client display/edit. */
function configScalars(config: unknown): Record<string, ConfigScalar> | undefined {
  if (typeof config !== 'object' || config === null) return undefined
  const scalars: Record<string, ConfigScalar> = {}
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      scalars[key] = value
    }
  }
  return Object.keys(scalars).length === 0 ? undefined : scalars
}

/** Check whether a plugin is part of the core application runtime infrastructure. */
export function isProtectedPlugin(moduleName: string): boolean {
  return PROTECTED_PLUGINS.has(moduleName)
}

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   * @returns Current non-group Loader entries in Loader order.
   */
  @Remote('list')
  list(): PluginInventorySnapshot {
    const entries: PluginInventoryEntry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group || entry.options.name === 'cordis:include' || entry.options.name === 'cordis:group') continue
      const config = configScalars(entry.options.config)
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
        isProtected: isProtectedPlugin(entry.options.name),
        ...(config === undefined ? {} : { config }),
      })
    }
    return { entries }
  }

  @Remote('toggle')
  async toggle(entryId: PluginEntryId, enabled: boolean): Promise<void> {
    const entry = this.ctx.loader.resolve(entryId)
    if (isProtectedPlugin(entry.options.name)) {
      throw new Error(`Cannot toggle core infrastructure plugin "${entry.options.name}"`)
    }
    // Update entry in-memory directly to avoid Loader tree.write() mutations on base bundle files
    await entry.update({ disabled: !enabled })
  }

  /**
   * Merge scalar config values into a Loader entry's config and reload it.
   * Runtime-scoped like `toggle`: the profile patch remains the durable source.
   * @param entryId Loader entry to reconfigure.
   * @param patch Scalar config values to merge over the current config.
   */
  @Remote('configure')
  async configure(entryId: PluginEntryId, patch: Record<string, ConfigScalar>): Promise<void> {
    const entry = this.ctx.loader.resolve(entryId)
    if (isProtectedPlugin(entry.options.name)) {
      throw new Error(`Cannot reconfigure core infrastructure plugin "${entry.options.name}"`)
    }
    const current = configScalars(entry.options.config) ?? {}
    await entry.update({ config: { ...current, ...patch } })
  }
}

export default PluginInventoryGateway
