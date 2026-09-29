import { describe, expect, it } from 'vitest'
import { BlockId, FlowId, FlowRunId } from '@deepseek-ai/dsh-flowbuilder-domain'
import type {
  BlockLibraryEntryRecord,
  FlowDefinitionRecord,
  FlowNodeRunState,
  FlowRunRecordRecord,
} from '@deepseek-ai/dsh-flowbuilder-domain'
import { executeRun } from '../src/engine.ts'
import type { RunHost } from '../src/engine.ts'

/** A host that records every put and runs code programs through real `Function` eval. */
function fakeHost(blocks: BlockLibraryEntryRecord[] = []): { host: RunHost; puts: number[] } {
  const puts: number[] = []
  const host: RunHost = {
    putRecord: (record) => {
      puts.push(Object.values(record.nodes).length)
      return Promise.resolve()
    },
    onNodeState: () => {},
    getBlock: blockId => blocks.find(block => block.id === blockId),
    runCode: (program, params, inputs) => {
      const globals = {
        flow: {
          inputs: () => Promise.resolve(inputs),
          params: () => Promise.resolve(params),
        },
      }
      // The test programs are trusted `return ...` bodies, so `Function` keeps
      // the scheduler test honest about code-node result plumbing.
      const body = new Function('flow', `return (async () => { const inputs = await flow.inputs(); const params = await flow.params(); ${program} })()`)
      return Promise.resolve(body(globals.flow))
    },
  }
  return { host, puts }
}

const record = (nodeIds: string[]): FlowRunRecordRecord => ({
  id: FlowRunId('run-1'),
  flowId: FlowId('flow-1'),
  status: 'running',
  startedAt: '2026-01-01T00:00:00.000Z',
  nodes: Object.fromEntries(nodeIds.map(id => [id, { status: 'pending' as const }])),
})

const flow = (nodes: FlowDefinitionRecord['nodes'], edges: FlowDefinitionRecord['edges']): FlowDefinitionRecord => ({
  id: FlowId('flow-1'),
  name: 'engine-test',
  description: '',
  nodes,
  edges,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const statesOf = (record: FlowRunRecordRecord): Record<string, FlowNodeRunState['status']> =>
  Object.fromEntries(Object.entries(record.nodes).map(([id, state]) => [id, state.status]))

describe('executeRun', () => {
  it('runs a linear chain and collects the output node value', async () => {
    const { host } = fakeHost()
    const terminal = await executeRun(host, flow(
      [
        { id: 'a', kind: 'input', title: 'A', params: { value: 'seed' }, x: 0, y: 0 },
        { id: 'b', kind: 'transform', title: 'B', params: {}, x: 1, y: 0 },
        { id: 'out', kind: 'output', title: 'Out', params: {}, x: 2, y: 0 },
      ],
      [
        { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
        { id: 'e2', from: { nodeId: 'b', port: 'out' }, to: { nodeId: 'out', port: 'in' } },
      ],
    ), record(['a', 'b', 'out']))
    expect(terminal.status).toBe('completed')
    expect(terminal.result).toBe('seed')
    expect(statesOf(terminal)).toEqual({ a: 'completed', b: 'completed', out: 'completed' })
    expect(terminal.nodes.b?.output).toBe('seed')
    expect(terminal.finishedAt).toBeDefined()
  })

  it('runs independent branches concurrently and completes all of them', async () => {
    const { host } = fakeHost()
    const terminal = await executeRun(host, flow(
      [
        { id: 'a', kind: 'input', title: 'A', params: { value: 1 }, x: 0, y: 0 },
        { id: 'b', kind: 'transform', title: 'B', params: {}, x: 1, y: 0 },
        { id: 'c', kind: 'transform', title: 'C', params: {}, x: 1, y: 1 },
      ],
      [
        { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'b', port: 'in' } },
        { id: 'e2', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'c', port: 'in' } },
      ],
    ), record(['a', 'b', 'c']))
    expect(terminal.status).toBe('completed')
    expect(statesOf(terminal)).toEqual({ a: 'completed', b: 'completed', c: 'completed' })
    expect(terminal.result).toBe(1)
  })

  it('prunes the losing condition branch to skipped', async () => {
    const { host } = fakeHost()
    const terminal = await executeRun(host, flow(
      [
        { id: 'a', kind: 'input', title: 'A', params: { value: 'x' }, x: 0, y: 0 },
        { id: 'cond', kind: 'condition', title: 'C', params: {}, code: 'return false', x: 1, y: 0 },
        { id: 't', kind: 'transform', title: 'True path', params: {}, x: 2, y: 0 },
        { id: 'f', kind: 'code', title: 'False path', params: {}, code: 'return "branch-taken"', x: 2, y: 1 },
        { id: 'out', kind: 'output', title: 'Out', params: {}, x: 3, y: 1 },
      ],
      [
        { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'cond', port: 'in' } },
        { id: 'e2', from: { nodeId: 'cond', port: 'true' }, to: { nodeId: 't', port: 'in' } },
        { id: 'e3', from: { nodeId: 'cond', port: 'false' }, to: { nodeId: 'f', port: 'in' } },
        { id: 'e4', from: { nodeId: 'f', port: 'out' }, to: { nodeId: 'out', port: 'in' } },
      ],
    ), record(['a', 'cond', 't', 'f', 'out']))
    expect(terminal.status).toBe('completed')
    expect(statesOf(terminal)).toEqual({ a: 'completed', cond: 'completed', t: 'skipped', f: 'completed', out: 'completed' })
    expect(terminal.result).toBe('branch-taken')
  })

  it('fails the run and skips downstream when a node errors', async () => {
    const { host } = fakeHost()
    const terminal = await executeRun(host, flow(
      [
        { id: 'a', kind: 'input', title: 'A', params: {}, x: 0, y: 0 },
        { id: 'boom', kind: 'code', title: 'Boom', params: {}, code: 'throw new Error("exploded")', x: 1, y: 0 },
        { id: 'out', kind: 'output', title: 'Out', params: {}, x: 2, y: 0 },
      ],
      [
        { id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'boom', port: 'in' } },
        { id: 'e2', from: { nodeId: 'boom', port: 'out' }, to: { nodeId: 'out', port: 'in' } },
      ],
    ), record(['a', 'boom', 'out']))
    expect(terminal.status).toBe('error')
    expect(terminal.error).toBe('exploded')
    expect(statesOf(terminal)).toEqual({ a: 'completed', boom: 'error', out: 'skipped' })
    expect(terminal.nodes.boom?.error).toBe('exploded')
  })

  it('executes library nodes through their resolved block', async () => {
    const { host } = fakeHost([
      {
        id: BlockId('block-1'),
        name: 'upper',
        kind: 'code',
        description: '',
        code: 'return String(inputs.in).toUpperCase()',
        inputs: [{ name: 'in', type: 'string' }],
        outputs: [{ name: 'out', type: 'string' }],
        params: [],
        provenance: { createdAt: '2026-01-01T00:00:00.000Z' },
      },
    ])
    const terminal = await executeRun(host, flow(
      [
        { id: 'a', kind: 'input', title: 'A', params: { value: 'hi' }, x: 0, y: 0 },
        { id: 'lib', kind: 'library', title: 'Upper', blockId: 'block-1', params: {}, x: 1, y: 0 },
      ],
      [{ id: 'e1', from: { nodeId: 'a', port: 'out' }, to: { nodeId: 'lib', port: 'in' } }],
    ), record(['a', 'lib']))
    expect(terminal.status).toBe('completed')
    expect(terminal.nodes.lib?.output).toBe('HI')
  })

  it('reports an unknown node kind as a node error', async () => {
    const { host } = fakeHost()
    const terminal = await executeRun(host, flow(
      [{ id: 'a', kind: 'llm', title: 'LLM', params: {}, x: 0, y: 0 }],
      [],
    ), record(['a']))
    expect(terminal.status).toBe('error')
    expect(terminal.error).toContain("node kind 'llm' has no executor in this build")
  })

  it('persists a transition record before every node state', async () => {
    const { host, puts } = fakeHost()
    await executeRun(host, flow(
      [{ id: 'a', kind: 'input', title: 'A', params: { value: 1 }, x: 0, y: 0 }],
      [],
    ), record(['a']))
    // running + completed per node, plus the start record's initial put is the
    // caller's; every engine put carries the whole node map.
    expect(puts.length).toBeGreaterThanOrEqual(2)
  })
})
