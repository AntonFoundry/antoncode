/**
 * flow.ts: the Dag Flow graph model and its geometry — board→graph placement,
 * layered layout, handle anchors, bezier paths, connection validation, and the
 * viewport maths (clamp, zoom about a point, fit, pan, minimap scale).
 */
import { describe, expect, it } from 'vitest'
import type { SessionId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionSummary as WireSummary } from '@deepseek-ai/dsh-host-apiproxy/api/sessions.ts'
import type { BoardSnapshot } from '../src/client/bridge.ts'
import {
  FLOW_KINDS,
  FLOW_STATUS_CLASS,
  FLOW_STATUS_ORDER,
  MAX_SCALE,
  MIN_SCALE,
  bezierPath,
  boundsOf,
  buildFlow,
  centreOn,
  clampScale,
  edgeShapes,
  fitView,
  handlePoint,
  isLiveStatus,
  isValidConnection,
  layoutFlow,
  minimapScale,
  nodeSize,
  panBy,
  placedNodes,
  toPlane,
  zoomAt,
  type FlowBox,
  type FlowGraph,
} from '../src/client/flow.ts'

const NOW = 1_000_000

/** One wire session summary; `updatedAt` defaults to the comparison instant. */
const summary = (id: string, over: Partial<WireSummary> = {}): WireSummary => ({
  sessionId: id as SessionId,
  updatedAt: NOW,
  running: false,
  blank: false,
  ...over,
})

/** One workspace row owning the given session ids, in order. */
const workspace = (workspaceId: string, sessionIds: string[]): WorkspaceView => ({
  workspaceId: workspaceId as WorkspaceView['workspaceId'],
  path: `/tmp/${workspaceId}`,
  title: workspaceId,
  sessionIds: sessionIds.map(s => s as SessionId),
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

/** A board snapshot with everything overridable. */
const board = (over: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  items: [],
  archivedSessionIds: [],
  sessions: [],
  ...over,
})

/** A todos projection block carrying the given nested tree. */
const todosOf = (todos: unknown): WireSummary['projections'] =>
  ({ asOfSeq: 1, values: { todos } }) as WireSummary['projections']

const NESTED_TODOS = [
  { content: 'ship the canvas', status: 'completed' },
  {
    content: 'polish handles',
    status: 'in_progress',
    children: [{ content: 'label the ports', status: 'pending' }],
  },
]

describe('buildFlow', () => {
  it('places missions in workspace order with their spawned agents and plan tasks', () => {
    const graph = buildFlow(board({
      items: [workspace('w1', ['root-a', 'root-b'])],
      sessions: [
        summary('root-a', { running: true, projections: todosOf(NESTED_TODOS) }),
        summary('root-b'),
        summary('child', { origin: 'subagent', parentSessionId: 'root-a' as SessionId, running: true }),
      ],
    }), { now: NOW })

    expect(graph.nodes.map(n => n.id)).toEqual([
      'mission:root-a',
      'task:root-a#0',
      'task:root-a#1',
      'task:root-a#1.0',
      'agent:child',
      'mission:root-b',
    ])
    expect(graph.edges.map(e => e.id)).toEqual([
      'mission:root-a:plan->task:root-a#0:in',
      'mission:root-a:plan->task:root-a#1:in',
      'task:root-a#1:out->task:root-a#1.0:in',
      'mission:root-a:plan->agent:child:in',
    ])
    const running = graph.nodes[0]
    expect(running).toMatchObject({ kind: 'mission', status: 'running', depth: 0, parentId: null, path: '' })
    expect(running?.outputs).toEqual([{ id: 'plan', side: 'output', label: 'plan' }])
    expect(graph.nodes.find(n => n.id === 'agent:child')).toMatchObject({ kind: 'agent', depth: 1, parentId: 'mission:root-a' })
    expect(graph.nodes.find(n => n.id === 'task:root-a#1.0')).toMatchObject({
      kind: 'task',
      depth: 2,
      path: '1.0',
      status: 'pending',
      parentId: 'task:root-a#1',
    })
  })

  it('animates only edges leaving live work', () => {
    const graph = buildFlow(board({
      items: [workspace('w', ['root'])],
      sessions: [summary('root', { running: true, projections: todosOf(NESTED_TODOS) })],
    }), { now: NOW })
    // Mission is running, so its plan edges flow; the in-progress task's edge flows too.
    expect(graph.edges.map(e => e.animated)).toEqual([true, true, true])
  })

  it('never renders an archived session, while its subagent still renders as a root', () => {
    const graph = buildFlow(board({
      items: [workspace('w', ['gone'])],
      archivedSessionIds: ['gone' as SessionId],
      sessions: [summary('gone'), summary('kid', { origin: 'subagent', parentSessionId: 'gone' as SessionId })],
    }), { now: NOW })
    expect(graph.nodes).toEqual([expect.objectContaining({ id: 'agent:kid', depth: 0, parentId: null })])
    expect(graph.edges).toEqual([])
  })

  it('places a subagent whose parent is off-board as a root', () => {
    const graph = buildFlow(board({
      items: [workspace('w', [])],
      sessions: [summary('orphan', { origin: 'subagent', parentSessionId: 'missing' as SessionId, running: true })],
    }), { now: NOW })
    expect(graph.nodes).toEqual([expect.objectContaining({ id: 'agent:orphan', depth: 0, parentId: null, status: 'running' })])
  })

  it('keeps the first placement when a session is listed twice', () => {
    const graph = buildFlow(board({
      items: [workspace('w1', ['root']), workspace('w2', ['root'])],
      sessions: [summary('root')],
    }), { now: NOW })
    expect(graph.nodes.map(n => n.id)).toEqual(['mission:root'])
  })

  it('skips workspace ids with no summary and non-subagent children', () => {
    const graph = buildFlow(board({
      items: [workspace('w', ['listed-but-absent', 'root']), workspace('empty', [])],
      sessions: [
        summary('root'),
        // A session that shares the parent id but did not originate as a subagent.
        summary('sibling', { parentSessionId: 'root' as SessionId }),
      ],
    }), { now: NOW })
    expect(graph.nodes.map(n => n.id)).toEqual(['mission:root'])
  })

  it('classifies a stale non-running session as done and a recent one as queued', () => {
    const graph = buildFlow(board({
      items: [workspace('w', ['stale', 'fresh'])],
      sessions: [
        summary('stale', { updatedAt: NOW - 2 * 86_400_000 }),
        summary('fresh', { updatedAt: NOW - 60_000 }),
      ],
    }), { now: NOW })
    expect(graph.nodes.map(n => n.status)).toEqual(['done', 'queued'])
  })

  it('adds task nodes only for sessions that carry a todos projection', () => {
    const graph = buildFlow(board({
      items: [workspace('w', ['bare', 'planned'])],
      sessions: [summary('bare'), summary('planned', { projections: todosOf(NESTED_TODOS) })],
    }), { now: NOW })
    expect(graph.nodes.map(n => n.id))
      .toEqual(['mission:bare', 'mission:planned', 'task:planned#0', 'task:planned#1', 'task:planned#1.0'])
  })

  it('renders no task nodes at all when tasks are switched off', () => {
    const graph = buildFlow(board({
      items: [workspace('w', ['planned'])],
      sessions: [summary('planned', { projections: todosOf(NESTED_TODOS) })],
    }), { now: NOW, includeTasks: false })
    expect(graph.nodes.map(n => n.id)).toEqual(['mission:planned'])
  })

  it('overlays display titles and defaults the instant and title map', () => {
    const graph = buildFlow(board({
      items: [workspace('w', ['root'])],
      sessions: [summary('root', { updatedAt: Date.now() })],
    }), { titles: new Map([['root', 'Root mission']]) })
    expect(graph.nodes[0]?.label).toBe('Root mission')
    expect(graph.nodes[0]?.subtitle).toBe('root')
    expect(graph.nodes[0]?.status).toBe('queued')
  })

  it('labels a uid-less node with its own session id', () => {
    const graph = buildFlow(board({
      items: [workspace('w', ['root'])],
      sessions: [summary('root')],
    }), { now: NOW })
    expect(graph.nodes[0]?.label).toBe('root')
  })
})

describe('isValidConnection', () => {
  const graph: FlowGraph = buildFlow(board({
    items: [workspace('w', ['a', 'b'])],
    sessions: [summary('a'), summary('b')],
  }), { now: NOW })

  it('accepts an output meeting an input on two distinct nodes', () => {
    expect(isValidConnection(graph, { source: 'mission:a', sourceHandle: 'plan', target: 'mission:b', targetHandle: 'in' })).toBe(true)
  })

  it('rejects self-links, unknown nodes, and unknown handles', () => {
    expect(isValidConnection(graph, { source: 'mission:a', sourceHandle: 'plan', target: 'mission:a', targetHandle: 'in' })).toBe(false)
    expect(isValidConnection(graph, { source: 'nope', sourceHandle: 'plan', target: 'mission:b', targetHandle: 'in' })).toBe(false)
    expect(isValidConnection(graph, { source: 'mission:a', sourceHandle: 'plan', target: 'nope', targetHandle: 'in' })).toBe(false)
    expect(isValidConnection(graph, { source: 'mission:a', sourceHandle: 'in', target: 'mission:b', targetHandle: 'in' })).toBe(false)
    expect(isValidConnection(graph, { source: 'mission:a', sourceHandle: 'plan', target: 'mission:b', targetHandle: 'plan' })).toBe(false)
  })
})

describe('layoutFlow', () => {
  const graph = buildFlow(board({
    items: [workspace('w', ['root'])],
    sessions: [summary('root', { projections: todosOf(NESTED_TODOS) })],
  }), { now: NOW })

  it('gives every node a box in a column of its depth', () => {
    const boxes = layoutFlow(graph)
    expect([...boxes.keys()]).toEqual(graph.nodes.map(n => n.id))
    const mission = boxes.get('mission:root')
    const task = boxes.get('task:root#0')
    const sub = boxes.get('task:root#1.0')
    expect(mission?.x).toBe(0)
    expect(task?.x).toBeGreaterThan(mission?.x ?? 0)
    expect(sub?.x).toBeGreaterThan(task?.x ?? 0)
    expect(mission).toMatchObject({ width: nodeSize('mission').width, height: nodeSize('mission').height })
  })

  it('separates stacked cards of one column by the row gap', () => {
    // Two childless missions at depth 0, so the parent-centring pass moves nothing.
    const flat = buildFlow(board({
      items: [workspace('w', ['one', 'two'])],
      sessions: [summary('one'), summary('two')],
    }), { now: NOW })
    const boxes = layoutFlow(flat, { rowGap: 10 })
    const first = boxes.get('mission:one')
    const second = boxes.get('mission:two')
    expect((second?.y ?? 0) - ((first?.y ?? 0) + (first?.height ?? 0))).toBe(10)
  })

  it('centres a parent over the vertical span of its children', () => {
    const boxes = layoutFlow(graph)
    const parent = boxes.get('task:root#1')
    const child = boxes.get('task:root#1.0')
    expect(parent?.y).toBe((child?.y ?? 0) + ((child?.height ?? 0) - (parent?.height ?? 0)) / 2)
  })

  it('uses the column gap override and returns an empty map for a bare graph', () => {
    const boxes = layoutFlow(graph, { columnGap: 5 })
    expect(boxes.get('task:root#0')?.x).toBe(nodeSize('mission').width + 5)
    expect(layoutFlow({ nodes: [], edges: [] }).size).toBe(0)
  })
})

describe('placedNodes and edgeShapes', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'a', kind: 'mission', sessionId: 'a', path: '', label: 'a', subtitle: 'a', status: 'running', parentId: null, depth: 0, order: 0, inputs: [], outputs: [] },
      { id: 'b', kind: 'task', sessionId: 'a', path: '0', label: 'b', subtitle: 'task 0', status: 'pending', parentId: 'a', depth: 1, order: 0, inputs: [], outputs: [] },
    ],
    edges: [
      { id: 'e1', source: 'a', sourceHandle: 'plan', target: 'b', targetHandle: 'in', animated: true },
      { id: 'e2', source: 'ghost', sourceHandle: 'plan', target: 'b', targetHandle: 'in', animated: false },
      { id: 'e3', source: 'a', sourceHandle: 'plan', target: 'ghost', targetHandle: 'in', animated: false },
    ],
  }
  const boxes = new Map<string, FlowBox>([
    ['a', { x: 0, y: 0, width: 232, height: 72 }],
    ['b', { x: 328, y: 0, width: 176, height: 44 }],
  ])

  it('pairs each node with its box and drops unplaced nodes', () => {
    expect(placedNodes(graph, boxes).map(entry => entry.node.id)).toEqual(['a', 'b'])
    expect(placedNodes(graph, new Map()).map(entry => entry.node.id)).toEqual([])
  })

  it('draws only edges whose source and target both exist and are placed', () => {
    expect(edgeShapes(graph, boxes)).toEqual([
      { id: 'e1', d: bezierPath({ x: 232, y: 36 }, { x: 328, y: 22 }), status: 'running', animated: true },
    ])
    expect(edgeShapes(graph, new Map()).length).toBe(0)
  })

  it('drops an edge whose endpoints are missing from the layout one at a time', () => {
    const withoutSource = new Map<string, FlowBox>([['b', { x: 328, y: 0, width: 176, height: 44 }]])
    const withoutTarget = new Map<string, FlowBox>([['a', { x: 0, y: 0, width: 232, height: 72 }]])
    expect(edgeShapes(graph, withoutSource).length).toBe(0)
    expect(edgeShapes(graph, withoutTarget).length).toBe(0)
  })
})

describe('geometry', () => {
  it('exposes one class key per kind and per status, ordered for the legend', () => {
    expect(Object.keys(FLOW_STATUS_CLASS).sort()).toEqual([...FLOW_STATUS_ORDER].sort())
    expect(FLOW_KINDS).toEqual(['mission', 'agent', 'task'])
    expect(isLiveStatus('running')).toBe(true)
    expect(isLiveStatus('in_progress')).toBe(true)
    expect(isLiveStatus('done')).toBe(false)
  })

  it('clamps the zoom scale into range', () => {
    expect(clampScale(1)).toBe(1)
    expect(clampScale(0.001)).toBe(MIN_SCALE)
    expect(clampScale(99)).toBe(MAX_SCALE)
  })

  it('anchors handles on the left edge for inputs and the right edge for outputs', () => {
    const box: FlowBox = { x: 10, y: 20, width: 100, height: 40 }
    expect(handlePoint(box, 'input')).toEqual({ x: 10, y: 40 })
    expect(handlePoint(box, 'output')).toEqual({ x: 110, y: 40 })
  })

  it('keeps a minimum separation between close handles and widens with distance', () => {
    expect(bezierPath({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe('M 0,0 C 32,0 -22,0 10,0')
    expect(bezierPath({ x: 0, y: 0 }, { x: 200, y: 50 })).toBe('M 0,0 C 100,0 100,50 200,50')
  })

  it('measures bounds and reports a zero box for nothing', () => {
    expect(boundsOf([
      { x: 0, y: 0, width: 10, height: 20 },
      { x: 30, y: -5, width: 10, height: 10 },
    ])).toEqual({ minX: 0, minY: -5, maxX: 40, maxY: 20 })
    expect(boundsOf([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 })
  })

  it('zooms about a point, holding it fixed and clamping the scale', () => {
    const view = { x: 0, y: 0, scale: 1 }
    expect(zoomAt(view, 2, { x: 100, y: 100 })).toEqual({ scale: 2, x: -100, y: -100 })
    expect(zoomAt(view, 0.01, { x: 100, y: 100 }).scale).toBe(MIN_SCALE)
    expect(zoomAt(view, 100, { x: 100, y: 100 }).scale).toBe(MAX_SCALE)
  })

  it('fits bounds with padding, never magnifying past 1', () => {
    expect(fitView({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, { x: 300, y: 300 }, 50))
      .toEqual({ scale: 1, x: 100, y: 100 })
    const wide = fitView({ minX: 0, minY: 0, maxX: 1000, maxY: 100 }, { x: 300, y: 300 }, 50)
    expect(wide.scale).toBeCloseTo(0.2)
    // A taller-than-wide box is bounded by the vertical fit instead.
    const tall = fitView({ minX: 0, minY: 0, maxX: 100, maxY: 1000 }, { x: 300, y: 300 }, 50)
    expect(tall.scale).toBeCloseTo(0.2)
    // Degenerate bounds are treated as one unit rather than dividing by zero.
    expect(fitView({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, { x: 300, y: 300 }, 50)).toEqual({ scale: 1, x: 144.5, y: 144.5 })
  })

  it('pans by a screen delta and projects screen points back to the plane', () => {
    expect(panBy({ x: 1, y: 2, scale: 2 }, 3, 4)).toEqual({ x: 4, y: 6, scale: 2 })
    expect(toPlane({ x: -100, y: -100, scale: 2 }, { x: 100, y: 100 })).toEqual({ x: 100, y: 100 })
  })

  it('centres a plane point and scales a minimap to fit, never magnifying', () => {
    expect(centreOn({ x: 0, y: 0, scale: 2 }, { x: 50, y: 50 }, { x: 200, y: 100 })).toEqual({ scale: 2, x: 0, y: -50 })
    expect(minimapScale({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }, { x: 176, y: 116 })).toBeCloseTo(0.104)
    expect(minimapScale({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { x: 176, y: 116 })).toBe(1)
    // Degenerate bounds are treated as one unit rather than dividing by zero.
    expect(minimapScale({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, { x: 176, y: 116 })).toBe(1)
  })
})
