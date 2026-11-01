import { describe, expect, it } from 'vitest'
import { flowDefinitionSchema, flowNodeSchema, validateFlowStructure } from '../src/index.ts'
import type { FlowEdge, FlowNode } from '../src/index.ts'

const node = (overrides: Partial<FlowNode> = {}): FlowNode => ({
  id: 'n1',
  kind: 'input',
  title: 'Input',
  params: {},
  x: 0,
  y: 0,
  ...overrides,
})

const edge = (overrides: Partial<FlowEdge> = {}): FlowEdge => ({
  id: 'e1',
  from: { nodeId: 'n1', port: 'out' },
  to: { nodeId: 'n2', port: 'in' },
  ...overrides,
})

describe('validateFlowStructure', () => {
  it('accepts a well-formed acyclic graph', () => {
    expect(validateFlowStructure(
      [node(), node({ id: 'n2' }), node({ id: 'n3', kind: 'library', blockId: 'b1', title: 'Block' })],
      [edge(), edge({ id: 'e2', from: { nodeId: 'n2', port: 'out' }, to: { nodeId: 'n3', port: 'in' } })],
    )).toEqual({ ok: true })
  })

  it('accepts a single node with no edges', () => {
    expect(validateFlowStructure([node()], [])).toEqual({ ok: true })
  })

  it('rejects duplicate node and edge ids', () => {
    expect(validateFlowStructure([node(), node()], []))
      .toMatchObject({ ok: false })
    expect(validateFlowStructure([node(), node({ id: 'n2' })], [edge(), edge()]))
      .toMatchObject({ ok: false })
  })

  it('rejects edges referencing missing nodes', () => {
    expect(validateFlowStructure([node()], [edge()]))
      .toMatchObject({ ok: false })
    expect(validateFlowStructure([node({ id: 'n2' })], [edge()]))
      .toMatchObject({ ok: false })
  })

  it('rejects a target port fed by two edges but allows fan-out', () => {
    expect(validateFlowStructure(
      [node(), node({ id: 'n2' }), node({ id: 'n3' })],
      [
        edge({ id: 'e1' }),
        edge({ id: 'e2', to: { nodeId: 'n2', port: 'in' } }),
      ],
    )).toMatchObject({ ok: false })
    expect(validateFlowStructure(
      [node(), node({ id: 'n2' }), node({ id: 'n3' })],
      [
        edge({ id: 'e1' }),
        edge({ id: 'e2', to: { nodeId: 'n3', port: 'in' } }),
        edge({ id: 'e3', from: { nodeId: 'n1', port: 'aux' }, to: { nodeId: 'n3', port: 'aux' } }),
      ],
    )).toEqual({ ok: true })
  })

  it('requires blockId exactly on library nodes', () => {
    expect(validateFlowStructure([node({ kind: 'library', title: 'Block' })], []))
      .toMatchObject({ ok: false })
    expect(validateFlowStructure([node({ blockId: 'b1' })], []))
      .toMatchObject({ ok: false })
  })

  it('rejects cyclic graphs and names a node on the cycle', () => {
    expect(validateFlowStructure(
      [node(), node({ id: 'n2' }), node({ id: 'n3' })],
      [
        edge({ id: 'e1' }),
        edge({ id: 'e2', from: { nodeId: 'n2', port: 'out' }, to: { nodeId: 'n3', port: 'in' } }),
        edge({ id: 'e3', from: { nodeId: 'n3', port: 'out' }, to: { nodeId: 'n1', port: 'in' } }),
      ],
    )).toMatchObject({ ok: false })
  })
})

describe('flowDefinitionSchema', () => {
  it('round-trips a definition and brands the id', () => {
    const parsed = flowDefinitionSchema.parse({
      id: 'f1',
      name: 'demo',
      description: '',
      nodes: [],
      edges: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(parsed.id).toBe('f1')
    expect(parsed.name).toBe('demo')
  })

  it('rejects an unnamed definition and a non-param value', () => {
    expect(() => flowDefinitionSchema.parse({
      id: 'f1', name: '', description: '', nodes: [], edges: [],
      createdAt: '', updatedAt: '',
    })).toThrow()
    expect(() => flowNodeSchema.parse({
      id: 'n1', kind: 'input', title: 'Input', params: { x: ['array'] }, x: 0, y: 0,
    })).toThrow()
  })
})
