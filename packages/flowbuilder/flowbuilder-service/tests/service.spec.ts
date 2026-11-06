import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { FlowBuilderService } from '../src/index.ts'
import { legacyBlockMetadataKey } from '@deepseek-ai/dsh-flowbuilder-domain/src/block-storage.ts'
import type { FlowNode, FlowSaveRequest } from '@deepseek-ai/dsh-flowbuilder-domain'
import { Service } from '@deepseek-ai/cordis'
import type { PtcJsonValue, PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

/** Boot a real storage stack (json backend on a fresh or given temp dir) plus the service. */
async function harness(root?: string): Promise<{ ctx: Context; service: FlowBuilderService; root: string }> {
  root = root ?? await mkdtemp(join(tmpdir(), 'flowbuilder-service-'))
  if (!roots.includes(root)) roots.push(root)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(FlowBuilderService)
  return { ctx, service: ctx.flowBuilder, root }
}

const node = (overrides: Partial<FlowNode> = {}): FlowNode => ({
  id: 'n1',
  kind: 'input',
  title: 'Input',
  params: {},
  x: 0,
  y: 0,
  ...overrides,
})

const saveRequest = (overrides: Record<string, unknown> = {}) => ({
  name: 'demo',
  description: 'A demo flow',
  nodes: [node(), node({ id: 'n2', kind: 'output', title: 'Output' })],
  edges: [{ id: 'e1', from: { nodeId: 'n1', port: 'out' }, to: { nodeId: 'n2', port: 'in' } }],
  ...overrides,
})

describe('FlowBuilderService flows', () => {
  it('saves, lists, reads, and round-trips a definition across a restart', async () => {
    const first = await harness()
    const saved = await first.service.saveFlow(saveRequest())
    expect(saved.id.length).toBeGreaterThan(0)
    expect(saved.createdAt).toBe(saved.updatedAt)
    expect(first.service.listFlows().map(flow => flow.id)).toEqual([saved.id])

    // A fresh context over the same storage root re-opens the durable domain.
    const second = await harness(first.root)
    expect(second.service.getFlow(saved.id)?.name).toBe('demo')
    expect(second.service.listFlows()).toHaveLength(1)

    const updated = await second.service.saveFlow(saveRequest({ id: saved.id, name: 'demo-2' }))
    expect(updated.id).toBe(saved.id)
    expect(updated.createdAt).toBe(saved.createdAt)
    expect(updated.updatedAt >= saved.updatedAt).toBe(true)
    expect(second.service.getFlow(saved.id)?.name).toBe('demo-2')
    expect(second.service.listFlows()).toHaveLength(1)
  })

  it('rejects cyclic graphs without writing anything', async () => {
    const { service } = await harness()
    await expect(service.saveFlow(saveRequest({
      nodes: [node(), node({ id: 'n2' })],
      edges: [
        { id: 'e1', from: { nodeId: 'n1', port: 'out' }, to: { nodeId: 'n2', port: 'in' } },
        { id: 'e2', from: { nodeId: 'n2', port: 'out' }, to: { nodeId: 'n1', port: 'in' } },
      ],
    }))).rejects.toThrow(/cycle/)
    expect(service.listFlows()).toHaveLength(0)
  })

  it('deletes an existing flow and throws on unknown ids', async () => {
    const { service } = await harness()
    const saved = await service.saveFlow(saveRequest())
    const removed = await service.deleteFlow(saved.id)
    expect(removed.id).toBe(saved.id)
    expect(service.listFlows()).toHaveLength(0)
    await expect(service.deleteFlow(saved.id)).rejects.toThrow(/unknown flow/)
  })

  it('emits flow-changed after each durable write', async () => {
    const { ctx, service } = await harness()
    const events: string[] = []
    ctx.on('flowbuilder/flow-changed', (action) => { events.push(action) })
    const saved = await service.saveFlow(saveRequest())
    await service.deleteFlow(saved.id)
    expect(events).toEqual(['saved', 'deleted'])
  })
})

/** A PtcRuntime stand-in that runs the test programs with real `Function` eval. */
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

describe('FlowBuilderService runs', () => {
  const runFlowRequest: FlowSaveRequest = {
    name: 'pipeline',
    description: 'code pipeline',
    nodes: [
      { id: 'a', kind: 'input', title: 'A', params: { value: 'seed' } },
      { id: 'b', kind: 'code', title: 'B', params: {}, code: 'return String(inputs.in).toUpperCase()' },
      { id: 'out', kind: 'output', title: 'Out', params: {} },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
      { id: 'e2', from: { nodeId: 'b', port: 'out' }, to: { nodeId: 'out', port: 'in' } },
    ],
  }

  it('runs a saved workflow to completion over the real store', async () => {
    const { ctx, service } = await harness()
    await ctx.plugin(FakeCodeRuntime)
    const events: string[] = []
    ctx.on('flowbuilder/run-start', () => { events.push('start') })
    ctx.on('flowbuilder/run-node', () => { events.push('node') })
    ctx.on('flowbuilder/run-end', () => { events.push('end') })

    const saved = await service.saveFlow(runFlowRequest)
    const runId = await service.runFlow(saved.id)
    expect(typeof runId).toBe('string')

    let run = service.getRun(runId)
    for (let tries = 0; tries < 500 && run?.status === 'running'; tries++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      run = service.getRun(runId)
    }
    expect(run).toBeDefined()
    if (run === undefined) throw new Error('unreachable')
    expect(run.status).toBe('completed')
    expect(run.result).toBe('SEED')
    expect(run.finishedAt).toBeDefined()
    expect(statesOf(run)).toEqual({ a: 'completed', b: 'completed', out: 'completed' })
    // start, then running+completed per node, then end — a complete pairing.
    expect(events[0]).toBe('start')
    expect(events[events.length - 1]).toBe('end')
    expect(events.filter(entry => entry === 'node').length).toBe(6)
    expect(service.listRuns().map(entry => entry.id)).toContain(runId)
    expect(service.listRuns(saved.id)).toHaveLength(1)
    expect(service.getRun('nope')).toBeUndefined()
  })

  it('rejects runFlow for unknown flows', async () => {
    const { service } = await harness()
    await expect(service.runFlow('missing')).rejects.toThrow(/unknown flow/)
  })
})

function statesOf(run: { nodes: Record<string, { status: string }> }): Record<string, string> {
  return Object.fromEntries(Object.entries(run.nodes).map(([id, state]) => [id, state.status]))
}

describe('FlowBuilderService library', () => {
  const blockRequest = (overrides: Record<string, unknown> = {}) => ({
    name: 'fetch-title',
    kind: 'http' as const,
    description: 'Fetches a page title',
    inputs: [{ name: 'url', type: 'string' as const }],
    outputs: [{ name: 'title', type: 'string' as const }],
    params: [{ name: 'timeout', type: 'number' as const, default: 5000 }],
    ...overrides,
  })

  it('saves, searches, and deletes blocks', async () => {
    const { service } = await harness()
    const saved = await service.saveBlock(blockRequest())
    expect(saved.createdAt.length).toBeGreaterThan(0)
    await service.saveBlock(blockRequest({ name: 'summarize', kind: 'llm', description: 'Summarizes text' }))
    expect(service.listBlocks()).toHaveLength(2)
    expect(service.listBlocks('summar').map(block => block.name)).toEqual(['summarize'])
    expect(service.getBlock(saved.id)?.name).toBe('fetch-title')
    const removed = await service.deleteBlock(saved.id)
    expect(removed.id).toBe(saved.id)
    await expect(service.deleteBlock(saved.id)).rejects.toThrow(/unknown block/)
  })

  it('replaces a same-name block when no id is given, preserving id and creation timestamp', async () => {
    const { service } = await harness()
    const saved = await service.saveBlock(blockRequest())
    const revised = await service.saveBlock(blockRequest({ description: 'Fetches a page title, v2' }))
    expect(revised.id).toBe(saved.id)
    expect(revised.createdAt).toBe(saved.createdAt)
    expect(service.listBlocks()).toHaveLength(1)
  })

  it('reads v1 blocks and reopens mixed stored generations after a v2 mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowbuilder-legacy-'))
    roots.push(root)
    const createdAt = '2026-01-01T00:00:00.000Z'
    const oldBlock = (id: string) => ({
      ...blockRequest({ name: id }), id,
      [legacyBlockMetadataKey]: { createdAt, sourceFlowId: 'flow-original' },
    })
    const path = join(root, 'flowbuilder.json')
    const original = JSON.stringify({
      unit: { name: 'flowbuilder', version: 1 }, global: { initialized: true },
      tables: { flows: {}, runs: {}, library: { old1: oldBlock('old1'), old2: oldBlock('old2') } },
    })
    await writeFile(path, original)
    const first = await harness(root)
    try {
      expect(await readFile(path, 'utf8')).toBe(original)
      expect(first.service.getBlock('old1')).toMatchObject({ createdAt, sourceFlowId: 'flow-original' })
      expect(first.service.getBlock('old1')).not.toHaveProperty(legacyBlockMetadataKey)
      const revised = await first.service.saveBlock(blockRequest({ id: 'old1', name: 'old1', description: 'Updated' }))
      expect(revised).toMatchObject({ createdAt, sourceFlowId: 'flow-original' })
      expect(revised).not.toHaveProperty(legacyBlockMetadataKey)
      const stored = JSON.parse(await readFile(path, 'utf8')) as {
        unit: { version: number }
        tables: { library: Record<string, Record<string, unknown>> }
      }
      expect(stored.unit.version).toBe(2)
      expect(stored.tables.library.old1).toMatchObject({ createdAt, sourceFlowId: 'flow-original' })
      expect(stored.tables.library.old1).not.toHaveProperty(legacyBlockMetadataKey)
      expect(stored.tables.library.old2).toEqual(oldBlock('old2'))
    } finally {
      await first.ctx.storageDomain.closeAll()
    }
    const second = await harness(root)
    try {
      expect(second.service.listBlocks()).toHaveLength(2)
      for (const id of ['old1', 'old2']) {
        expect(second.service.getBlock(id)).toMatchObject({ createdAt, sourceFlowId: 'flow-original' })
        expect(second.service.getBlock(id)).not.toHaveProperty(legacyBlockMetadataKey)
      }
    } finally {
      await second.ctx.storageDomain.closeAll()
    }
  })

  it('rejects a code block without code', async () => {
    const { service } = await harness()
    await expect(service.saveBlock(blockRequest({ kind: 'code' }))).rejects.toThrow(/carries no code/)
  })
})
