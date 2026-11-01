import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import FlowBuilderService from '@deepseek-ai/dsh-flowbuilder-service'
import * as ToolFlowbuilder from '@deepseek-ai/dsh-tool-flowbuilder'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a real cordis.yml composition — storage backend, flowbuilder service,
 * tool runtime, and the flowbuilder tool plugin — through the real Loader,
 * with every workspace module supplied directly (no built lib dependency).
 */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-flowbuilder-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${root}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-flowbuilder-service'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
    "- name: '@deepseek-ai/dsh-tool-flowbuilder'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-flowbuilder-service', FlowBuilderService],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-tool-flowbuilder', ToolFlowbuilder],
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

const WORKFLOW = {
  name: 'demo',
  description: 'A demo flow',
  nodes: [
    { id: 'n1', kind: 'input', title: 'Input' },
    { id: 'n2', kind: 'output', title: 'Output' },
  ],
  edges: [{ id: 'e1', from: { nodeId: 'n1', port: 'out' }, to: { nodeId: 'n2', port: 'in' } }],
}

describe('tool-flowbuilder real Loader composition through cordis.yml', () => {
  it('boots the store stack, registers the flow tools, and saves a workflow end to end', async () => {
    const ctx = await boot()
    const names = ctx.tools.schemas().map(schema => schema.name)
    for (const expected of ['flow_list', 'flow_get', 'flow_save', 'flow_library_search', 'flow_block_save']) {
      expect(names).toContain(expected)
    }

    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('flow-save-1'),
      name: 'flow_save',
      arguments: WORKFLOW,
    })
    expect(result.isError ?? false).toBe(false)
    expect(resultText(result)).toContain('It is on the Dag Flow canvas.')
    expect(ctx.flowBuilder.listFlows()).toHaveLength(1)
    expect(ctx.flowBuilder.listFlows()[0]?.nodes).toHaveLength(2)
  }, 30_000)

  it('assembles the authoring prompt section into the model prompt', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(entry => entry.name === 'tool:flowbuilder')
    expect(section?.text).toContain('flow_save')
    expect(section?.text).toContain('Dag Flow canvas')
  }, 30_000)
})
