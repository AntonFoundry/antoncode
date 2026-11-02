import { afterEach, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState, type Plugin } from '@deepseek-ai/cordis'
import {
  PluginPackages, pluginStatePath, pluginStatePatches, readPluginMeta, type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import PluginInventoryGateway from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

const previousHome = process.env.DSH_HOME

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const activePlugin: Plugin.Function = () => {}
const configurablePlugin: Plugin.Function = () => {}
const pendingPlugin: Plugin.Object = {
  inject: ['neverReady'],
  apply() {},
}

async function harness(baseUrl?: string): Promise<{
  ctx: Context
  inventory: PluginInventoryGateway
}> {
  const ctx = new Context()
  contexts.push(ctx)
  if (baseUrl !== undefined) ctx.baseUrl = baseUrl
  // The durable state lands in the harness home; each test gets its own.
  const home = mkdtempSync(join(tmpdir(), 'dsh-plugin-inventory-home-'))
  roots.push(home)
  process.env.DSH_HOME = home
  await ctx.plugin(Loader)
  ctx.loader.builtins.active = activePlugin
  ctx.loader.builtins.configurable = configurablePlugin
  ctx.loader.builtins.pending = pendingPlugin
  await ctx.plugin(PluginInventoryGateway)
  const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
  return { ctx, inventory }
}

function metadataFixture(mode: 'native' | 'runtime') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inventory-meta-'))
  roots.push(root)
  const profilesDir = join(root, 'profiles')
  const profileDir = join(profilesDir, 'test')
  const baseDir = mode === 'runtime' ? profileDir : root
  mkdirSync(baseDir, { recursive: true })
  const baseUrl = pathToFileURL(join(baseDir, 'entry.mjs')).href
  const dir = mode === 'runtime'
    ? join(root, 'installation', 'node_modules', 'local-plugin')
    : join(root, 'node_modules', 'local-plugin')
  const resolution: RuntimeResolution = {
    profilesDir, profileDir, localPackageNames: [], linkedRoots: [],
    entries: [{ name: 'local-plugin', packageDir: dir, version: undefined,
      declarer: join(dir, 'package.json'), scope: 'installation' }],
  }
  const expectUnlinked = () => {
    expect(lstatSync(dir).isDirectory()).toBe(true)
    for (const path of [
      join(profileDir, 'node_modules'), join(profilesDir, 'node_modules'),
      join(root, 'node_modules'), join(profileDir, '.dsh-module-fallback'),
    ]) expect(lstatSync(path, { throwIfNoEntry: false }), path).toBeUndefined()
  }
  return { dir, baseUrl, resolution, expectUnlinked }
}

describe('PluginInventoryGateway', () => {
  it('sends preset plugin changes to the owning registry', async () => {
    const { ctx, inventory } = await harness()
    await expect(inventory.togglePreset('standard', 'persona', false)).rejects.toThrow('unavailable')
    const setPluginEnabled = vi.fn(async () => {})
    ctx.provide('agentPresets', { setPluginEnabled } as Partial<AgentPresetRegistry> as never)
    await inventory.togglePreset('standard', 'persona', false)
    expect(setPluginEnabled).toHaveBeenCalledExactlyOnceWith('standard', 'persona', false)
  })

  it.each(['native', 'runtime'] as const)('reads local metadata while the package entry remains disabled with %s resolution', async (mode) => {
    const { dir, baseUrl, resolution, expectUnlinked } = metadataFixture(mode)
    mkdirSync(join(dir, 'locale'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'local-plugin', exports: { './feature': './index.js', './feature/locale/*.json': './locale/*.json' },
    }))
    writeFileSync(join(dir, 'index.js'), 'throw new Error("metadata must not execute the plugin")\n')
    writeFileSync(join(dir, 'locale', 'en.json'), '{"meta":{"title":"Local plugin","description":"Local description"}}')
    if (mode === 'runtime') {
      expectUnlinked()
      expect(readPluginMeta('local-plugin/feature', baseUrl)).toBeUndefined()
    }
    const { ctx, inventory } = await harness(baseUrl)
    await ctx.plugin(PluginPackages, mode === 'runtime' ? { resolution } : {})
    await ctx.loader.create({ name: 'local-plugin/feature', disabled: true })
    expect((await inventory.list()).entries).toMatchObject([{
      enabled: false, fiberPhase: null, meta: { title: { en: 'Local plugin' }, description: { en: 'Local description' } },
    }])
    if (mode === 'runtime') {
      expectUnlinked()
      await ctx.fiber.dispose()
      expect(readPluginMeta('local-plugin/feature', baseUrl)).toBeUndefined()
      expectUnlinked()
    }
  })

  it.each(['native', 'runtime'] as const)('resolves preset row metadata from the profile base without loading the plugins with %s resolution', async (mode) => {
    const { dir, baseUrl, resolution, expectUnlinked } = metadataFixture(mode)
    mkdirSync(join(dir, 'locale'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'local-plugin', exports: { './feature': './index.js', './feature/locale/*.json': './locale/*.json' },
    }))
    writeFileSync(join(dir, 'index.js'), 'throw new Error("metadata must not execute the plugin")\n')
    writeFileSync(join(dir, 'locale', 'en.json'), '{"meta":{"title":"Preset plugin","description":"Preset description"}}')
    writeFileSync(join(dir, 'locale', 'zh.json'), '{"meta":{"title":"预设插件"}}')
    if (mode === 'runtime') {
      expectUnlinked()
      expect(readPluginMeta('local-plugin/feature', baseUrl)).toBeUndefined()
    }
    const { ctx, inventory } = await harness(baseUrl)
    await ctx.plugin(PluginPackages, mode === 'runtime' ? { resolution } : {})
    ctx.provide('agentPresets', {
      compositionInventory: async () => [{
        id: 'local', isDefault: true,
        rows: [
          { entryId: 'feature', moduleName: 'local-plugin/feature', enabled: false },
          { entryId: null, moduleName: 'local-plugin/private', enabled: false },
        ],
      }],
    } as Partial<AgentPresetRegistry> as never)

    expect(await inventory.list()).toEqual({
      entries: [],
      agentPresets: [{
        id: 'local', isDefault: true,
        rows: [
          {
            entryId: 'feature', moduleName: 'local-plugin/feature', enabled: false, fiberPhase: null,
            meta: { title: { en: 'Preset plugin', zh: '预设插件' }, description: { en: 'Preset description' } },
          },
          { entryId: null, moduleName: 'local-plugin/private', enabled: false, fiberPhase: null },
        ],
      }],
    })
    if (mode === 'runtime') {
      expectUnlinked()
      await ctx.fiber.dispose()
      expect(readPluginMeta('local-plugin/feature', baseUrl)).toBeUndefined()
      expectUnlinked()
    }
  })

  it('publishes direct inventory and edit methods under the pluginInventory namespace', async () => {
    const { inventory } = await harness()
    expect(inventory.typertRemote).toMatchObject({
      serviceKey: 'pluginInventory',
      namespace: 'pluginInventory',
    })
    expect(remoteMethods(inventory)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'toggle', invocation: { kind: 'direct' } },
      { method: 'togglePreset', invocation: { kind: 'direct' } },
      { method: 'configure', invocation: { kind: 'direct' } },
    ])
  })

  it.each(['error', 'stack object'] as const)('reads %s startup diagnostics from failed fibers and clears them after recovery', async (kind) => {
    const { ctx, inventory } = await harness()
    const failure: unknown = kind === 'error' ? new Error('native preparation unavailable')
      : { stack: 'plugin startup failure', toString: () => 'native preparation unavailable' }
    ctx.loader.builtins.failing = {
      async apply(_ctx: Context, config: { fail: boolean }) {
        if (config.fail) throw failure
      },
    }
    const entry = ctx.loader.resolve(await ctx.loader.create({ name: 'cordis:failing', config: { fail: true } }))
    await expect(entry.fiber!.await()).rejects.toBe(failure)
    for (let index = 0; index < 2; index++) {
      expect((await inventory.list()).entries).toContainEqual({
        entryId: entry.id, moduleName: 'cordis:failing', enabled: true,
        fiberPhase: 'failed', diagnostic: 'native preparation unavailable', isProtected: false, config: { fail: true },
      })
    }
    await entry.update({ config: { fail: false } })
    await entry.fiber!.await()
    expect((await inventory.list()).entries).toContainEqual({
      entryId: entry.id, moduleName: 'cordis:failing', enabled: true, fiberPhase: 'active', isProtected: false,
      config: { fail: false },
    })
  })

  it('projects current non-group Loader entries without a second cache', async () => {
    const { ctx, inventory } = await harness()
    const activeId = await ctx.loader.create({ name: 'cordis:active' })
    const pendingId = await ctx.loader.create({ name: 'cordis:pending' })
    const disabledId = await ctx.loader.create({
      name: 'cordis:not-installed',
      disabled: true,
    })
    await ctx.loader.create({ name: 'cordis:active', group: true })

    const snapshot = await inventory.list()
    // No agent-preset roster is composed, so the snapshot carries no presets.
    expect(snapshot.agentPresets).toBeUndefined()
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      {
        entryId: activeId,
        moduleName: 'cordis:active',
        enabled: true,
        fiberPhase: 'active',
        isProtected: false,
      },
      {
        entryId: pendingId,
        moduleName: 'cordis:pending',
        enabled: true,
        fiberPhase: 'pending',
        isProtected: false,
      },
      {
        entryId: disabledId,
        moduleName: 'cordis:not-installed',
        enabled: false,
        fiberPhase: null,
        isProtected: false,
      },
    ]))

    await ctx.loader.update(activeId, { disabled: true })
    expect((await inventory.list()).entries.find(entry => entry.entryId === activeId)).toEqual({
      entryId: activeId,
      moduleName: 'cordis:active',
      enabled: false,
      fiberPhase: null,
      isProtected: false,
    })

    ctx.loader.remove(pendingId)
    expect((await inventory.list()).entries.some(entry => entry.entryId === pendingId)).toBe(false)
  })

  it('carries each composed preset with root-fiber states mapped to phases', async () => {
    const { ctx, inventory } = await harness()
    ctx.provide('agentPresets', {
      compositionInventory: async () => [
        {
          id: 'standard',
          name: '标准模式',
          isDefault: true,
          rows: [
            { entryId: 'alpha', moduleName: 'pkg-alpha', enabled: true, fiberState: FiberState.ACTIVE },
            { entryId: null, moduleName: 'pkg-file', enabled: 'conditional', condition: 'x' },
          ],
        },
        { id: 'damaged', isDefault: false, broken: 'the composition file is missing', rows: [] },
      ],
    } as Partial<AgentPresetRegistry> as never)

    const snapshot = await inventory.list()
    expect(snapshot.agentPresets).toEqual([
      {
        id: 'standard',
        name: '标准模式',
        isDefault: true,
        rows: [
          { entryId: 'alpha', moduleName: 'pkg-alpha', enabled: true, fiberPhase: 'active' },
          { entryId: null, moduleName: 'pkg-file', enabled: 'conditional', condition: 'x', fiberPhase: null },
        ],
      },
      { id: 'damaged', isDefault: false, broken: 'the composition file is missing', rows: [] },
    ])
  })

  it('toggles a plugin entry state via remote toggle and guards protected plugins', async () => {
    const { ctx, inventory } = await harness()
    const activeId = await ctx.loader.create({ name: 'cordis:active' })
    expect((await inventory.list()).entries.find(e => e.entryId === activeId)?.enabled).toBe(true)

    await inventory.toggle(activeId as never, false)
    expect((await inventory.list()).entries.find(e => e.entryId === activeId)?.enabled).toBe(false)
    // The toggle persists: the state file stores the disabled flag and boot
    // converts it into the id-targeted patch row that survives reinstalls.
    expect(pluginStatePatches(pluginStatePath())).toEqual([{ id: activeId, disabled: true }])

    await inventory.toggle(activeId as never, true)
    expect((await inventory.list()).entries.find(e => e.entryId === activeId)?.enabled).toBe(true)
    expect(pluginStatePatches(pluginStatePath())).toEqual([{ id: activeId, disabled: false }])

    // Protected plugin should throw
    ctx.loader.builtins.include = () => {}
    const includeId = await ctx.loader.create({ name: 'cordis:include' })
    await expect(inventory.toggle(includeId as never, false)).rejects.toThrow('Cannot toggle core infrastructure plugin')
  })

  it('merges scalar config via remote configure, projects scalars only, and guards protected plugins', async () => {
    const { ctx, inventory } = await harness()
    const entryId = await ctx.loader.create({
      name: 'cordis:configurable',
      config: { endpoint: 'http://127.0.0.1:8090', apiKey: 'ctx_old', requestedZones: ['goal'] },
    })

    await inventory.configure(entryId as never, { endpoint: 'http://127.0.0.1:9000', apiKey: 'ctx_new' })
    expect((await inventory.list()).entries.find(entry => entry.entryId === entryId)?.config).toEqual({
      endpoint: 'http://127.0.0.1:9000',
      apiKey: 'ctx_new',
    })
    // The durable store mirrors the live entry after the scalar merge (the
    // established configure semantics): boot re-applies exactly what the
    // runtime shows.
    expect(pluginStatePatches(pluginStatePath())).toEqual([{
      id: entryId,
      config: { endpoint: 'http://127.0.0.1:9000', apiKey: 'ctx_new' },
    }])

    // Protected plugin should throw
    ctx.loader.builtins.include = () => {}
    const includeId = await ctx.loader.create({ name: 'cordis:include' })
    await expect(inventory.configure(includeId as never, { endpoint: 'http://example.invalid' }))
      .rejects.toThrow('Cannot reconfigure core infrastructure plugin')
  })
})
