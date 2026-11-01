import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import FlowBuilderService from '@deepseek-ai/dsh-flowbuilder-service'
import { Service } from '@deepseek-ai/cordis'
import type { PtcJsonValue, PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import * as tool from '../src/index.ts'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

const testToolSignal = new AbortController().signal

/** A PtcRuntime stand-in that runs the flow's code nodes with real `Function` eval. */
class FakeCodeRuntime extends Service {
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'ptcRuntime')
  }

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 30_000 }
  }

  async run(request: PtcRunSpec): Promise<PtcRunResult> {
    const globals: Record<string, unknown> = {}
    for (const binding of request.bindings) {
      globals[binding.global] = Object.fromEntries(
        Object.entries(binding.functions).map(([name, fn]) => [name, fn]),
      )
    }
    // oxlint-disable-next-line typescript/no-implied-eval -- the stand-in runs trusted in-test programs; that is what it fakes
    const body = new Function(...Object.keys(globals), `return (async () => { ${request.program} })()`)
    try {
      const value = await (body as (...args: unknown[]) => Promise<unknown>)(...Object.values(globals))
      return { value: value as PtcJsonValue, logs: [] }
    } catch (error: unknown) {
      return {
        logs: [],
        error: { kind: 'exception', message: error instanceof Error ? error.message : String(error) },
      }
    }
  }
}

/**
 * Boot the real stack: json storage backend, flowBuilder service, the tool
 * runtime, and the flowbuilder tool plugin — then drive the registered
 * `flow_*` tools through `ctx.tools.execute`.
 */
async function setup(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'tool-flowbuilder-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(FlowBuilderService)
  await ctx.plugin(FakeCodeRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(tool)
  return ctx
}

let callCounter = 0

function call(ctx: Context, name: string, args: Record<string, unknown>): ReturnType<typeof executeToolFixture> {
  return executeToolFixture(ctx, {
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
  })
}

const acyclic = {
  name: 'demo',
  description: 'A demo flow',
  nodes: [
    { id: 'n1', kind: 'input', title: 'Input', params: { value: 'seed' } },
    { id: 'n2', kind: 'code', title: 'Upper', code: 'return String(inputs.in).toUpperCase()' },
    { id: 'n3', kind: 'output', title: 'Output' },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 'n1', port: 'out' }, to: { nodeId: 'n2', port: 'in' } },
    { id: 'e2', from: { nodeId: 'n2', port: 'out' }, to: { nodeId: 'n3', port: 'in' } },
  ],
}

describe('dsh-tool-flowbuilder', () => {
  it('registers the five flow tools', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(schema => schema.name)
    for (const expected of ['flow_list', 'flow_get', 'flow_save', 'flow_library_search', 'flow_block_save']) {
      expect(names).toContain(expected)
    }
  })

  it('saves a workflow and reads it back through flow_get and flow_list', async () => {
    const ctx = await setup()
    await call(ctx, 'flow_save', acyclic)
    const listed = await call(ctx, 'flow_list', {})
    expect(listed.isError ?? false).toBe(false)
    expect(ctx.flowBuilder.listFlows()).toHaveLength(1)
    const id = ctx.flowBuilder.listFlows()[0]!.id
    await call(ctx, 'flow_get', { id })
    expect(ctx.flowBuilder.getFlow(id)?.name).toBe('demo')
  })

  it('surfaces the service cycle rejection as a tool error', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'flow_save', {
      ...acyclic,
      edges: [
        { id: 'e1', from: { nodeId: 'n1', port: 'out' }, to: { nodeId: 'n2', port: 'in' } },
        { id: 'e2', from: { nodeId: 'n2', port: 'out' }, to: { nodeId: 'n1', port: 'in' } },
      ],
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toMatch(/cycle/)
    expect(ctx.flowBuilder.listFlows()).toHaveLength(0)
  })

  it('saves library blocks and searches them by substring', async () => {
    const ctx = await setup()
    await call(ctx, 'flow_block_save', {
      name: 'fetch-title',
      kind: 'http',
      description: 'Fetches a page title',
    })
    await call(ctx, 'flow_block_save', {
      name: 'summarize',
      kind: 'llm',
      description: 'Summarizes text',
    })
    const searched = await call(ctx, 'flow_library_search', { query: 'summar' })
    expect(searched.isError ?? false).toBe(false)
    expect(ctx.flowBuilder.listBlocks('summar').map(block => block.name)).toEqual(['summarize'])
  })

  it('runs a saved workflow end to end and reports status', async () => {
    const ctx = await setup()
    await call(ctx, 'flow_save', acyclic)
    const flowId = ctx.flowBuilder.listFlows()[0]!.id
    const started = await call(ctx, 'flow_run', { flowId })
    expect(started.isError ?? false).toBe(false)
    const runId = ctx.flowBuilder.listRuns(flowId)[0]!.id

    let run = ctx.flowBuilder.getRun(runId)
    for (let tries = 0; tries < 500 && run?.status === 'running'; tries++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      run = ctx.flowBuilder.getRun(runId)
    }
    expect(run?.status).toBe('completed')

    const status = await call(ctx, 'flow_run_status', { runId })
    expect(status.isError ?? false).toBe(false)
    const text = JSON.stringify(status)
    expect(text).toContain('completed')
    expect(text).toContain('SEED')
    await expect(call(ctx, 'flow_run_status', { runId: 'missing' })).resolves.toMatchObject({ isError: true })
  }, 30_000)

  it('propagates the code-block-without-code rejection', async () => {
    const ctx = await setup()
    const result = await call(ctx, 'flow_block_save', {
      name: 'broken',
      kind: 'code',
      description: 'No code body',
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toMatch(/carries no code/)
  })
})
