/**
 * Durable plugin-state file (`$DSH_HOME/plugin-state.json`): write-through
 * merges, boot patch conversion, corruption tolerance, and the lossy-config
 * guard, plus one real `boot()` composition proving the state layer disables
 * and reconfigures bundle rows like any other patch layer.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boot, captureJsonState, loadPluginState, pluginStatePatches, updatePluginEntry } from '../src/index.ts'

const paths: string[] = []

afterEach(() => {
  paths.splice(0).forEach(path => {
    try {
      readFileSync(path)
    } catch {
      // Nothing to clean per-path; temp dirs are removed below.
    }
  })
})

function statePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-state-'))
  return join(dir, 'plugin-state.json')
}

describe('updatePluginEntry', () => {
  it('persists disabled and re-enabled toggles as explicit state', () => {
    const path = statePath()
    updatePluginEntry('row-a', { disabled: true }, path)
    expect(loadPluginState(path).entries['row-a']).toEqual({ disabled: true })
    updatePluginEntry('row-a', { disabled: false }, path)
    expect(loadPluginState(path).entries['row-a']).toEqual({ disabled: false })
  })

  it('merges config per entry and keeps other entries untouched', () => {
    const path = statePath()
    updatePluginEntry('row-a', { disabled: true }, path)
    updatePluginEntry('row-b', { config: { endpoint: 'http://127.0.0.1:1' } }, path)
    updatePluginEntry('row-b', { config: { endpoint: 'http://127.0.0.1:2', retries: 3 } }, path)
    const state = loadPluginState(path)
    expect(state.entries['row-a']).toEqual({ disabled: true })
    expect(state.entries['row-b']).toEqual({
      config: { endpoint: 'http://127.0.0.1:2', retries: 3 },
    })
  })

  it('drops a record that ends up carrying no state, keeps explicit re-enable state', () => {
    const path = statePath()
    // A config-only update resolving to an empty object is pure noise and is
    // removed instead of leaving an empty record behind.
    updatePluginEntry('row-b', { config: {} }, path)
    expect(loadPluginState(path).entries['row-b']).toBeUndefined()
    // An explicit re-enable (disabled: false) is durable user intent and stays.
    updatePluginEntry('row-a', { disabled: false }, path)
    expect(loadPluginState(path).entries['row-a']).toEqual({ disabled: false })
  })

  it('keeps the previous stored config and reports lossy when the live config cannot survive JSON', () => {
    const path = statePath()
    updatePluginEntry('row-a', { config: { endpoint: 'keep' } }, path)
    const result = updatePluginEntry('row-a', { config: { endpoint: 'new', root: () => 'non-json' } }, path)
    expect(result.configPersisted).toBe(false)
    expect(loadPluginState(path).entries['row-a']).toEqual({ config: { endpoint: 'keep' } })
  })

  it('round-trips through the atomic write without losing content', () => {
    const path = statePath()
    updatePluginEntry('row-a', { disabled: true, config: { flag: true } }, path)
    // The file on disk parses to the same state the API returned, written
    // through the temporary-then-rename path.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(loadPluginState(path))
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
  })
})

describe('captureJsonState', () => {
  it('clones JSON-safe values and flags lossy nodes', () => {
    expect(captureJsonState({ a: [1, 'x', null, true], b: { c: 2.5 } })).toEqual({
      value: { a: [1, 'x', null, true], b: { c: 2.5 } },
      lossy: false,
    })
    expect(captureJsonState(() => 'x').lossy).toBe(true)
    expect(captureJsonState({ ok: 1, bad: undefined }).lossy).toBe(true)
    expect(captureJsonState([Symbol('x')]).lossy).toBe(true)
    expect(captureJsonState(new Map()).lossy).toBe(true)
    expect(captureJsonState(10n ** 3n).lossy).toBe(true)
  })
})

describe('pluginStatePatches', () => {
  it('converts stored entries into id-targeted patch rows', () => {
    const path = statePath()
    updatePluginEntry('row-a', { disabled: true }, path)
    updatePluginEntry('row-b', { disabled: false, config: { endpoint: 'http://x' } }, path)
    expect(pluginStatePatches(path)).toEqual([
      { id: 'row-a', disabled: true },
      { id: 'row-b', disabled: false, config: { endpoint: 'http://x' } },
    ])
  })

  it('returns nothing for a missing or corrupt file', () => {
    expect(pluginStatePatches(join(tmpdir(), `dsh-plugin-state-missing-${Date.now()}.json`))).toEqual([])
    const path = statePath()
    writeFileSync(path, '{ torn json')
    expect(pluginStatePatches(path)).toEqual([])
  })
})

describe('plugin-state layer over a real boot composition', () => {
  it('disables and reconfigures bundle rows when applied as the state patch layer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-state-boot-'))
    const pluginState = join(dir, 'plugin-state.json')
    writeFileSync(join(dir, 'noop.mjs'), 'export const name = "noop"\nexport function apply() {}\n')
    // The empty root every dsh profile mounts; the tree comes from patches.
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    // The user disabled one row and reconfigured another; both persist.
    updatePluginEntry('mute', { disabled: true }, pluginState)
    updatePluginEntry('tuned', { config: { endpoint: 'http://user-override' } }, pluginState)

    // Bundle-layer rows (an insert list) with the state layer appended —
    // the same ordering allPatches composes at profile boot.
    const bundleRows: Parameters<typeof boot>[2] = [
      { insert: [
        { id: 'keep', name: './noop.mjs' },
        { id: 'mute', name: './noop.mjs' },
        { id: 'tuned', name: './noop.mjs', config: { endpoint: 'http://bundle-default' } },
      ] },
    ]
    const ctx = await boot('dsh-test-bin', join(dir, 'cordis.yml'), [
      ...structuredClone(bundleRows),
      ...pluginStatePatches(pluginState),
    ])
    try {
      const entryById = (id: string) => {
        const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === id)
        if (!entry) throw new Error(`missing loader entry ${id}`)
        return entry
      }
      expect(entryById('keep').fiber).toBeDefined()
      expect(entryById('mute').options.disabled).toBe(true)
      expect(entryById('mute').fiber).toBeUndefined()
      expect(entryById('tuned').options.config).toEqual({ endpoint: 'http://user-override' })
      expect(entryById('tuned').fiber).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
