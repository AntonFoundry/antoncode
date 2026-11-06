/**
 * Durable plugin toggle/configure state: `$DSH_HOME/plugin-state.json`.
 *
 * The file lives in the harness home — outside every bundle and profile — so a
 * user's disabled set and plugin config edits survive restarts, rebuilds, and
 * full reinstalls of the app. The plugin inventory writes through on every
 * toggle/configure; profile boot converts the entries into the highest
 * automatic patch layer (after the home patch, before `--patch` overlays), so
 * a freshly installed bundle row is still disabled when the user disabled it
 * before. All readers tolerate a missing or corrupt file: the state is a
 * user convenience overlay, never a boot precondition.
 * @module @deepseek-ai/dsh-app-boot/plugin-state
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** JSON-safe scalar or nested value storable in the state file. */
export type PluginStateValue = string | number | boolean | null | PluginStateValue[] | { [key: string]: PluginStateValue }

/** One Loader entry's durable state, keyed by entry id. */
export interface PluginStateEntry {
  /** Explicit user toggle: `true` disabled, `false` re-enabled. */
  disabled?: boolean
  /** The entry's full JSON-safe config as of the last durable configure. */
  config?: Record<string, PluginStateValue>
}

/** On-disk shape of `plugin-state.json`. */
export interface PluginStateFile {
  version: 1
  entries: Record<string, PluginStateEntry>
}

/**
 * Locate the durable plugin-state file without creating or reading it.
 * @returns Absolute plugin-state.json path in the resolved harness home.
 */
export function pluginStatePath(): string {
  return join(resolveDshHome(), 'plugin-state.json')
}

/**
 * Read the state file, tolerating absence and corruption.
 * @param path - state-file path; defaults to the harness home.
 * @returns the parsed state, or an empty state when missing or unusable.
 */
export function loadPluginState(path: string = pluginStatePath()): PluginStateFile {
  if (!existsSync(path)) return { version: 1, entries: {} }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, entries: {} }
    const entries = (parsed as { entries?: unknown }).entries
    if (typeof entries !== 'object' || entries === null) return { version: 1, entries: {} }
    return { version: 1, entries: entries as Record<string, PluginStateEntry> }
  } catch {
    // A torn or hand-mangled state file must never block a boot: the overlay
    // is a convenience, and the next durable toggle rewrites it cleanly.
    return { version: 1, entries: {} }
  }
}

/**
 * Convert the state file into boot patch rows (`{ id, disabled?, config? }`),
 * one per entry that carries state, in stored order.
 * @param path - state-file path; defaults to the harness home.
 * @returns patch rows for profile composition.
 */
export function pluginStatePatches(path: string = pluginStatePath()): PatchOptions[] {
  const { entries } = loadPluginState(path)
  const patches: PatchOptions[] = []
  for (const [id, entry] of Object.entries(entries)) {
    const row: PatchOptions = { id }
    if (entry.disabled !== undefined) row.disabled = entry.disabled
    if (entry.config !== undefined && Object.keys(entry.config).length > 0) row.config = entry.config
    if (row.disabled !== undefined || row.config !== undefined) patches.push(row)
  }
  return patches
}

/**
 * Deep-clone a value into the JSON-safe state subset.
 * @param value - arbitrary config value (Loader configs may carry non-JSON `!!js` results).
 * @returns the clonable value, or `undefined` with `lossy` when any node
 *   (function, symbol, undefined, bigint) cannot survive a JSON round trip.
 */
export function captureJsonState(value: unknown): { value: PluginStateValue | undefined; lossy: boolean } {
  if (value === null) return { value: null, lossy: false }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return { value, lossy: false }
    case 'number':
      return { value: Number.isFinite(value) ? value : null, lossy: false }
    case 'object': {
      if (Array.isArray(value)) {
        const items: PluginStateValue[] = []
        let lossy = false
        for (const item of value) {
          const captured = captureJsonState(item)
          if (captured.lossy) lossy = true
          items.push(captured.value ?? null)
        }
        return { value: lossy ? undefined : items, lossy }
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) return { value: undefined, lossy: true }
      const record: Record<string, PluginStateValue> = {}
      let lossy = false
      for (const [key, item] of Object.entries(value)) {
        const captured = captureJsonState(item)
        if (captured.lossy) lossy = true
        else record[key] = captured.value as PluginStateValue
      }
      return { value: lossy ? undefined : record, lossy }
    }
    default:
      // function, symbol, undefined, bigint: cannot survive JSON storage.
      return { value: undefined, lossy: true }
  }
}

/** Result of {@link updatePluginEntry}. */
export interface PluginStateUpdate {
  /** The state file content after the merge. */
  state: PluginStateFile
  /** `false` when a requested config could not be stored (non-JSON nodes); the previous stored config, if any, is kept. */
  configPersisted: boolean
}

/**
 * Merge one entry's durable state and persist the file atomically
 * (write-to-temporary, then rename). A record that ends up carrying no
 * disabled flag and no config is removed entirely.
 * @param entryId - Loader entry id (the composition row id).
 * @param patch - the fields to store; `config` is the entry's FULL config
 *   (the boot patch replaces the whole key, not a merge), captured through
 *   {@link captureJsonState}.
 * @param path - state-file path; defaults to the harness home.
 * @returns the new state and whether the config was storable.
 */
export function updatePluginEntry(
  entryId: string,
  patch: { disabled?: boolean; config?: unknown },
  path: string = pluginStatePath(),
): PluginStateUpdate {
  const state = loadPluginState(path)
  const current = state.entries[entryId] ?? {}
  const merged: PluginStateEntry = { ...current }
  let configPersisted = true
  if (patch.disabled !== undefined) merged.disabled = patch.disabled
  if (patch.config !== undefined) {
    const captured = captureJsonState(patch.config)
    if (captured.lossy) {
      // The row's live config carries non-JSON nodes: replacing it wholesale
      // at boot would drop them, so keep whatever was stored before and let
      // the caller warn that this config edit stays runtime-scoped.
      configPersisted = false
    } else {
      merged.config = captured.value as Record<string, PluginStateValue>
    }
  }
  if (merged.disabled === undefined && (merged.config === undefined || Object.keys(merged.config).length === 0)) {
    // Persisted JSON entries use Loader entry ids; clearing an empty override must omit its key.
    // oxlint-disable-next-line typescript/no-dynamic-delete -- Delete the persisted JSON key, not a Map entry.
    delete state.entries[entryId]
  } else {
    state.entries[entryId] = merged
  }
  writePluginState(state, path)
  return { state, configPersisted }
}

/**
 * Persist the state file atomically: write a sibling temporary file, then
 * rename over the target, so a crash mid-write cannot leave a torn JSON file.
 * @param state - the complete state to store.
 * @param path - state-file path; defaults to the harness home.
 */
export function writePluginState(state: PluginStateFile, path: string = pluginStatePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(temporary, path)
}
