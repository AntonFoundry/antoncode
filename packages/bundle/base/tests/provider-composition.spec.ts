/** Native route ownership through the base bundle's real provider rows and Loader. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { Context } from '@deepseek-ai/cordis'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { auditStartupEntries, boot, composeEntries } from '@deepseek-ai/dsh-app-boot'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as LlmOpenai from '@deepseek-ai/dsh-llm-openai'
import * as LlmClaude from '@deepseek-ai/dsh-llm-claude'
import * as LlmCodex from '@deepseek-ai/dsh-llm-codex'

const roots: string[] = []
const contexts: Context[] = []
const basePath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const providerIds = new Set(['llm', 'llm-pi-ai', 'llm-openai', 'llm-claude', 'llm-codex'])

const modules = new Map<string, unknown>([
  ['@deepseek-ai/dsh-llm', LlmRuntime],
  ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ['@deepseek-ai/dsh-llm-openai', LlmOpenai],
  ['@deepseek-ai/dsh-llm-claude', LlmClaude],
  ['@deepseek-ai/dsh-llm-codex', LlmCodex],
])

function sourceModules(): ModuleLoaderV2 {
  return {
    version: 'v2',
    loadCache: new Map(),
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  // Each path comes directly from this spec's mkdtemp, after Loader teardown.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function composition(overrides: PatchOptions[] = []): Promise<{ ctx: Context; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-base-providers-'))
  roots.push(root)
  const patches = yaml.load(await readFile(basePath, 'utf8'), { schema: entryListSchema }) as PatchOptions[]
  // Keep the actual shipped provider rows, without unrelated tools or services.
  const rows = composeEntries([patches]).filter(row => providerIds.has(row.id ?? ''))
  expect(rows.map(row => row.id).sort()).toEqual([...providerIds].sort())
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, yaml.dump(rows, { schema: entryListSchema }))
  const ctx = await boot('base-provider-test', configPath, overrides, (ctx) => {
    ctx.loader.internal = sourceModules()
  })
  contexts.push(ctx)
  return { ctx, configPath }
}

describe('base provider composition', () => {
  it('offers one native entry per authentication route and retains unrelated pi-ai providers', async () => {
    const { ctx } = await composition([
      { id: 'llm-codex', config: { providers: { codex: {} } } },
    ])
    const directory = ctx.llm.listConfigurableProviders()
    expect(new Set(directory.map(row => row.provider)).size).toBe(directory.length)
    expect(directory.filter(row => ['anthropic', 'openai-codex'].includes(row.provider))).toEqual([])
    expect(directory.filter(row => ['openai', 'claude-code', 'codex', 'kimi-coding'].includes(row.provider))
      .map(({ provider, settingsNs, settingsPath }) => ({ provider, settingsNs, settingsPath }))
      .sort((left, right) => left.provider.localeCompare(right.provider)))
      .toMatchInlineSnapshot(`
        [
          {
            "provider": "claude-code",
            "settingsNs": "llm-claude",
            "settingsPath": [],
          },
          {
            "provider": "codex",
            "settingsNs": "llm-codex",
            "settingsPath": [
              "providers",
              "codex",
            ],
          },
          {
            "provider": "kimi-coding",
            "settingsNs": "llm-pi-ai",
            "settingsPath": [
              "providers",
              "kimi-coding",
            ],
          },
          {
            "provider": "openai",
            "settingsNs": "llm-openai",
            "settingsPath": [
              "providers",
              "openai",
            ],
          },
        ]
      `)
    expect(ctx.llm.listProviders().map(row => row.id).sort()).toEqual(['claude-code', 'codex'])
    const piAi = [...ctx.loader.entries()].find(entry => entry.options.id === 'llm-pi-ai')
    expect(piAi?.fiber).toBeDefined()
    await piAi!.fiber!.dispose()
    expect(ctx.llm.listConfigurableProviders().map(row => row.provider).sort())
      .toEqual(['claude-code', 'codex', 'openai', 'openai-compatible'])
    expect(ctx.llm.listProviders().map(row => row.id).sort()).toEqual(['claude-code', 'codex'])
  })

  it.each(['anthropic', 'openai-codex'])('refuses configured reserved %s without rewriting the source patch', async (provider) => {
    const before = await readFile(basePath, 'utf8')
    const { ctx, configPath } = await composition([{
      id: 'llm-pi-ai',
      config: { reservedProviders: ['openai', 'anthropic', 'openai-codex'], providers: { [provider]: {}, 'kimi-coding': {} } },
    }])
    const input = await readFile(configPath, 'utf8')
    const diagnostics: string[] = []
    await auditStartupEntries(ctx, 'base-provider-test', line => diagnostics.push(line))
    expect(diagnostics.join('')).toContain(`provider route "${provider}" is reserved by a native adapter`)
    expect(ctx.llm.listProviders().map(row => row.id)).not.toContain(provider)
    expect(ctx.llm.listConfigurableProviders().some(row => row.settingsNs === 'llm-pi-ai')).toBe(false)
    expect(await readFile(configPath, 'utf8')).toBe(input)
    expect(await readFile(basePath, 'utf8')).toBe(before)
  })

  it('supports an explicit legacy opt-out without removing native routes or other pi-ai providers', async () => {
    const { ctx } = await composition([{
      id: 'llm-pi-ai',
      config: { reservedProviders: ['openai'], providers: { anthropic: {}, 'openai-codex': {}, 'kimi-coding': {} } },
    }])
    expect(ctx.llm.listProviders().map(row => row.id).sort())
      .toEqual(['anthropic', 'claude-code', 'kimi-coding', 'openai-codex'])
    expect(ctx.llm.listConfigurableProviders().find(row => row.provider === 'codex')?.settingsNs).toBe('llm-codex')
    expect(ctx.llm.listConfigurableProviders().find(row => row.provider === 'anthropic')?.settingsNs).toBe('llm-pi-ai')
  })
})
