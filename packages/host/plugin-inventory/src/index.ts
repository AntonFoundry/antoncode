/**
 * Projection of the current Cordis Loader plugin entries, with durable
 * enable/disable and scalar-config edits for non-protected entries.
 */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: the optional agent-preset roster resolved through `ctx.get`.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { updatePluginEntry } from '@deepseek-ai/dsh-app-boot'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  AgentPresetPluginGroup,
  ConfigScalar,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from './types.ts'

export type * from './types.ts'

/**
 * Brand an existing Loader-tree entry id at the owning boundary.
 * @param value - the entry id as the Loader tree spells it.
 * @returns the same id as the inventory's branded entry id.
 */
export function pluginEntryId(value: string): PluginEntryId {
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
   *
   * When an agent-preset roster is composed, the snapshot also carries each
   * preset's composition rows, because those rows — not the Loader's own
   * entries — are where a deployment that mounts the roster runs its
   * model-facing plugins.
   * @returns Current non-group Loader entries in Loader order, with optional display metadata
   * and per-preset compositions when a roster is composed.
   */
  @Remote('list')
  async list(): Promise<PluginInventorySnapshot> {
    return readPluginInventory(this.ctx)
  }

  @Remote('toggle')
  async toggle(entryId: PluginEntryId, enabled: boolean): Promise<void> {
    const entry = this.ctx.loader.resolve(entryId)
    if (isProtectedPlugin(entry.options.name)) {
      throw new Error(`Cannot toggle core infrastructure plugin "${entry.options.name}"`)
    }
    // Update entry in-memory directly to avoid Loader tree.write() mutations on base bundle files
    await entry.update({ disabled: !enabled })
    // Durable half: the disabled set lands in `$DSH_HOME/plugin-state.json`,
    // which profile boot applies as the highest automatic patch layer — so
    // the state survives restarts, rebuilds, and full reinstalls (a fresh
    // bundle row the user disabled before stays disabled).
    updatePluginEntry(entryId, { disabled: !enabled })
  }

  /** Save one session plugin's enablement in its owning agent preset.
   * @param presetId - registered agent preset id.
   * @param entryId - child plugin id from the preset inventory.
   * @param enabled - whether subsequent Agents mount the child.
   */
  @Remote('togglePreset')
  async togglePreset(presetId: string, entryId: string, enabled: boolean): Promise<void> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) throw new Error('Agent presets are unavailable')
    await presets.setPluginEnabled(presetId, entryId, enabled)
  }

  /**
   * Merge scalar config values into a Loader entry's config and reload it.
   * The merged full config is persisted durably next to the disabled set; a
   * config carrying non-JSON nodes (e.g. `!!js` results) cannot be stored
   * without clobbering them at boot, so that edit stays runtime-scoped and
   * the warning names it.
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
    const persisted = updatePluginEntry(entryId, { config: entry.options.config })
    if (!persisted.configPersisted) {
      this.ctx.get('logger')?.warn(
        `plugin-state: config edit for "${entryId}" stays runtime-scoped — the live config carries non-JSON values that durable storage would drop`,
      )
    }
  }
}

export default PluginInventoryGateway

/** Read current Loader entries and optional preset compositions.
 * @param ctx Context with the Loader service.
 * @returns Current inventory with optional display metadata and no separate runtime cache.
 */
export async function readPluginInventory(ctx: Context): Promise<PluginInventorySnapshot> {
  const entries: PluginInventoryEntry[] = []
  const packages = ctx.get('pluginPackages')
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    const base = entry.parent.tree.ctx.baseUrl
    const meta = base === undefined ? undefined : packages?.metaOf(entry.options.name, base)
    const fiber = entry.fiber
    const fiberPhase = fiber === undefined ? null : FIBER_PHASE[fiber.state]
    const config = configScalars(entry.options.config)
    let diagnostic: string | undefined
    if (fiber !== undefined && fiberPhase === 'failed') {
      try { await fiber.await() } catch (error) { diagnostic = error instanceof Error ? error.message : String(error) }
    }
    entries.push({
      entryId: pluginEntryId(entry.id),
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      fiberPhase,
      isProtected: isProtectedPlugin(entry.options.name),
      ...diagnostic === undefined ? {} : { diagnostic },
      ...meta === undefined ? {} : { meta },
      ...config === undefined ? {} : { config },
    })
  }
  const presets = ctx.get('agentPresets')
  const management = ctx.get('pluginManager') === undefined ? {} : { managementAvailable: true }
  if (presets === undefined) return { entries, ...management }
  const agentPresets: AgentPresetPluginGroup[] = (await presets.compositionInventory()).map(
    composition => ({
      ...composition,
      rows: composition.rows.map(({ fiberState, ...row }) => {
        const meta = ctx.baseUrl === undefined ? undefined : packages?.metaOf(row.moduleName, ctx.baseUrl)
        return {
          ...row,
          fiberPhase: fiberState === undefined ? null : FIBER_PHASE[fiberState],
          ...meta === undefined ? {} : { meta },
        }
      }),
    }),
  )
  return { entries, agentPresets, ...management }
}
