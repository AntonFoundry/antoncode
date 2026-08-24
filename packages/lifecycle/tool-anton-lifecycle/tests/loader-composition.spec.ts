/**
 * Real Loader composition: the plugin boots from a cordis.yml through the production plugin
 * loader and its tools appear in the live tool registry, proving the function-plugin exports
 * (`name`/`inject`/`Config`/`apply`) survive real composition — and that the enable flags are
 * genuine configurability, not constants.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolAntonLifecycle from '@deepseek-ai/dsh-tool-anton-lifecycle'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the given lifecycle config block through the real Loader.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-anton-lifecycle'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-anton-lifecycle', ToolAntonLifecycle],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('tool-anton-lifecycle real Loader composition through cordis.yml', () => {
  it('registers all four lifecycle tools by default', async () => {
    const ctx = await boot([])
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('anton_')))
      .toEqual(['anton_status', 'anton_start', 'anton_stop', 'anton_restart'])
  }, 30_000)

  it('an enable flag set false removes only that tool', async () => {
    const ctx = await boot(['    stopToolEnabled: false'])
    const names = ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('anton_'))
    expect(names).toEqual(['anton_status', 'anton_start', 'anton_restart'])
  }, 30_000)

  it('fails loading when bridgeEndpoint is not HTTP(S)', async () => {
    await expect(boot(['    bridgeEndpoint: "ftp://127.0.0.1:3742"'])).rejects.toThrow('must use http or https')
  }, 30_000)
})
