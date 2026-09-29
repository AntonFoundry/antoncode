/**
 * flow domain behavior: the ten `flow.*` routes are thin projections over
 * `ctx.flowBuilder` — save/list/get/delete for definitions and library
 * blocks, run/start plus run polling — with the service's rejection
 * vocabulary mapped to the wire's flow-not-found / block-not-found /
 * run-not-found / flow-graph-invalid codes.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import FlowBuilderService from '@deepseek-ai/dsh-flowbuilder-service'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`flow-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function expectError<T>(response: RpcResponse<T>, code: string): string {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  expect(response.result.error.code).toBe(code)
  return response.result.error.message
}

/** The storage stack (memory backend) plus the flowbuilder service. */
async function harness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-flow-')))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(UserQuestionService)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  await ctx.plugin(FlowBuilderService)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: root,
  })
  return { api, root }
}

const workflow = {
  name: 'demo',
  description: 'A demo flow',
  nodes: [
    { id: 'a', kind: 'input', title: 'A', params: { value: 'seed' }, x: 0, y: 0 },
    { id: 'out', kind: 'output', title: 'Out', params: {}, x: 1, y: 0 },
  ],
  edges: [{ id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'out', port: 'in' } }],
}

const block = {
  name: 'shout',
  kind: 'code',
  description: 'Uppercases text',
  code: 'return String(inputs.in).toUpperCase()',
  inputs: [{ name: 'in', type: 'string' }],
  outputs: [{ name: 'out', type: 'string' }],
  params: [],
}

describe('flow.* definitions', () => {
  it('saves, lists, reads, and round-trips a definition', async () => {
    const { api } = await harness()
    const saved = expectOk(await api.flow.save(request(workflow)))
    expect(saved.flow.id.length).toBeGreaterThan(0)
    expect(saved.flow.nodes).toHaveLength(2)
    expect(expectOk(await api.flow.list(request({}))).flows).toHaveLength(1)
    expect(expectOk(await api.flow.get(request({ id: saved.flow.id }))).flow.name).toBe('demo')

    const updated = expectOk(await api.flow.save(request({ ...workflow, id: saved.flow.id, name: 'demo-2' })))
    expect(updated.flow.id).toBe(saved.flow.id)
    expect(expectOk(await api.flow.list(request({}))).flows).toHaveLength(1)
  })

  it('maps graph and lookup rejections to the wire error codes', async () => {
    const { api } = await harness()
    expectError(await api.flow.save(request({
      ...workflow,
      edges: [
        workflow.edges[0]!,
        { id: 'e2', from: { nodeId: 'out', port: 'out' }, to: { nodeId: 'a', port: 'in' } },
      ],
    })), 'flow-graph-invalid')
    expectError(await api.flow.get(request({ id: 'missing' })), 'flow-not-found')

    const saved = expectOk(await api.flow.save(request(workflow)))
    expect(expectOk(await api.flow.delete(request({ id: saved.flow.id })))).toEqual({ deleted: true })
    expectError(await api.flow.delete(request({ id: saved.flow.id })), 'flow-not-found')
  })
})

describe('flow.* library', () => {
  it('saves, searches, and deletes blocks', async () => {
    const { api } = await harness()
    const saved = expectOk(await api.flow.librarySave(request(block)))
    expect(saved.block.id.length).toBeGreaterThan(0)
    await api.flow.librarySave(request({ ...block, name: 'calm', description: 'Lowercases text' }))

    expect(expectOk(await api.flow.libraryList(request({}))).blocks).toHaveLength(2)
    const filtered = expectOk(await api.flow.libraryList(request({ query: 'shout' }))).blocks
    expect(filtered.map(entry => entry.name)).toEqual(['shout'])

    expect(expectOk(await api.flow.libraryDelete(request({ id: saved.block.id })))).toEqual({ deleted: true })
    expectError(await api.flow.libraryDelete(request({ id: saved.block.id })), 'block-not-found')
  })

  it('rejects a code block without code', async () => {
    const { api } = await harness()
    const { code: _code, ...withoutCode } = block
    expectError(await api.flow.librarySave(request(withoutCode)), 'flow-graph-invalid')
  })
})

describe('flow.run / flow.runGet', () => {
  it('runs a pure graph to a terminal record and serves it', async () => {
    const { api } = await harness()
    const saved = expectOk(await api.flow.save(request(workflow)))
    const { runId } = expectOk(await api.flow.run(request({ flowId: saved.flow.id })))
    expect(runId.length).toBeGreaterThan(0)
    expectError(await api.flow.runGet(request({ runId: 'missing' })), 'run-not-found')

    let run = expectOk(await api.flow.runGet(request({ runId }))).run
    for (let tries = 0; tries < 500 && run.status === 'running'; tries++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      run = expectOk(await api.flow.runGet(request({ runId }))).run
    }
    expect(run.status).toBe('completed')
    expect(run.result).toBe('seed')
    expect(run.nodes.out?.status).toBe('completed')
    expect(expectOk(await api.flow.runs(request({ flowId: saved.flow.id }))).runs).toHaveLength(1)
    expectError(await api.flow.run(request({ flowId: 'missing' })), 'flow-not-found')
  }, 30_000)
})
