import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { FlowBuilderService } from '../src/index.ts'
import type { FlowNode } from '@deepseek-ai/dsh-flowbuilder-domain'

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
    expect(saved.provenance.createdAt.length).toBeGreaterThan(0)
    await service.saveBlock(blockRequest({ name: 'summarize', kind: 'llm', description: 'Summarizes text' }))
    expect(service.listBlocks()).toHaveLength(2)
    expect(service.listBlocks('summar').map(block => block.name)).toEqual(['summarize'])
    expect(service.getBlock(saved.id)?.name).toBe('fetch-title')
    const removed = await service.deleteBlock(saved.id)
    expect(removed.id).toBe(saved.id)
    await expect(service.deleteBlock(saved.id)).rejects.toThrow(/unknown block/)
  })

  it('replaces a same-name block when no id is given, preserving id and provenance', async () => {
    const { service } = await harness()
    const saved = await service.saveBlock(blockRequest())
    const revised = await service.saveBlock(blockRequest({ description: 'Fetches a page title, v2' }))
    expect(revised.id).toBe(saved.id)
    expect(revised.provenance.createdAt).toBe(saved.provenance.createdAt)
    expect(service.listBlocks()).toHaveLength(1)
  })

  it('rejects a code block without code', async () => {
    const { service } = await harness()
    await expect(service.saveBlock(blockRequest({ kind: 'code' }))).rejects.toThrow(/carries no code/)
  })
})
