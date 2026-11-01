import { describe, expect, it } from 'vitest'
import { BlockId, FlowId, FlowRunId } from '@deepseek-ai/dsh-flowbuilder-domain'
import type {
  BlockLibraryEntryRecord,
  FlowDefinitionRecord,
  FlowNodeRunState,
  FlowRunRecordRecord,
} from '@deepseek-ai/dsh-flowbuilder-domain'
import { executeRun, renderTemplate } from '../src/engine.ts'
import type { RunHost } from '../src/engine.ts'

/** A host that records every put, fakes the external faces, and evals code programs. */
function fakeHost(
  blocks: BlockLibraryEntryRecord[] = [],
): { host: RunHost; puts: number[]; globals: Map<string, (input: unknown) => unknown> } {
  const puts: number[] = []
  const globals = new Map<string, (input: unknown) => unknown>()
  const host: RunHost = {
    putRecord: (record) => {
      puts.push(Object.values(record.nodes).length)
      return Promise.resolve()
    },
    onNodeState: () => {},
    getBlock: blockId => blocks.find(block => block.id === blockId),
    runLlm: (options): Promise<string> => {
      const body = globals.get('llm')
      if (body === undefined) return Promise.reject(new Error('llm service is not mounted in this composition'))
      return Promise.resolve(String(body(options)))
    },
    fetchUrl: (url): Promise<{ statusCode: number; body: string }> => {
      const body = globals.get('http')
      if (body === undefined) return Promise.reject(new Error('web service is not mounted in this composition'))
      return Promise.resolve({ statusCode: 200, body: String(body(url)) })
    },
    runShellCommand: (command): Promise<{ exitCode: number | null; stdout: string }> => {
      const body = globals.get('shell')
      if (body === undefined) return Promise.reject(new Error('shell service is not mounted in this composition'))
      return Promise.resolve(body(command) as { exitCode: number | null; stdout: string })
    },
    runCode: (program, params, inputs) => {
      const globals = {
        flow: {
          inputs: () => Promise.resolve(inputs),
          params: () => Promise.resolve(params),
        },
      }
      // The test programs are trusted `return ...` bodies, so `Function` keeps
      // the scheduler test honest about code-node result plumbing.
      // oxlint-disable-next-line typescript/no-implied-eval -- trusted in-test program bodies
      const body = new Function('flow', `return (async () => { const inputs = await flow.inputs(); const params = await flow.params(); ${program} })()`)
      return Promise.resolve((body as (flow: unknown) => unknown)(globals.flow))
    },
  }
  return { host, puts, globals }
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

  it('reports the agent node as unimplemented in this build', async () => {
    const { host } = fakeHost()
    const terminal = await executeRun(host, flow(
      [{ id: 'a', kind: 'agent', title: 'Agent', params: {}, x: 0, y: 0 }],
      [],
    ), record(['a']))
    expect(terminal.status).toBe('error')
    expect(terminal.error).toContain("node kind 'agent' has no executor in this build")
  })

  it('runs an llm node through the host face with templated prompt', async () => {
    const { host, globals } = fakeHost()
    globals.set('llm', (input) => {
      const llm = input as { system?: string; prompt: string }
      return `${llm.system ?? ''}|${llm.prompt}`
    })
    const terminal = await executeRun(host, flow(
      [
        { id: 'a', kind: 'input', title: 'A', params: { value: 'world' }, x: 0, y: 0 },
        {
          id: 'node', kind: 'llm', title: 'LLM',
          params: { provider: 'test', model: 'm', prompt: 'hi {{greeting}}', system: 'be brief' },
          x: 1, y: 0,
        },
      ],
      [{ id: 'e1', from: { nodeId: 'a', port: 'greeting' }, to: { nodeId: 'node', port: 'greeting' } }],
    ), record(['a', 'node']))
    expect(terminal.status).toBe('completed')
    expect(terminal.nodes.node?.output).toBe('be brief|hi world')
  })

  it('runs an http node and surfaces status plus body', async () => {
    const { host, globals } = fakeHost()
    globals.set('http', () => 'page-body')
    const terminal = await executeRun(host, flow(
      [{ id: 'node', kind: 'http', title: 'HTTP', params: { url: 'https://example.test' }, x: 0, y: 0 }],
      [],
    ), record(['node']))
    expect(terminal.status).toBe('completed')
    expect(terminal.nodes.node?.output).toEqual({ statusCode: 200, body: 'page-body' })
  })

  it('fails a shell node on nonzero exit and passes stdout through on success', async () => {
    const { host, globals } = fakeHost()
    globals.set('shell', () => ({ exitCode: 1, stdout: 'boom' }))
    const failed = await executeRun(host, flow(
      [{ id: 'node', kind: 'shell', title: 'Shell', params: { command: 'exit 1' }, x: 0, y: 0 }],
      [],
    ), record(['node']))
    expect(failed.status).toBe('error')
    expect(failed.error).toContain('command exited 1')

    globals.set('shell', () => ({ exitCode: 0, stdout: 'ok' }))
    const done = await executeRun(host, flow(
      [{ id: 'node', kind: 'shell', title: 'Shell', params: { command: 'true' }, x: 0, y: 0 }],
      [],
    ), record(['node']))
    expect(done.status).toBe('completed')
    expect(done.nodes.node?.output).toEqual({ exitCode: 0, stdout: 'ok' })
  })

  it('renders templates from string and structured inputs', async () => {
    expect(renderTemplate('hello {{name}} / {{count}} / {{missing}}', { name: 'flow', count: [1, 2] }))
      .toBe('hello flow / [1,2] / {{missing}}')
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
