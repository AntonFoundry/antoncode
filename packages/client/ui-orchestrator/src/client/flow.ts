/**
 * Dag Flow model: the Langflow-style node/edge graph derived from one
 * `orchestrator.board` snapshot, plus the pure geometry the canvas needs
 * (layered layout, handle anchors, bezier paths, pan/zoom viewport maths).
 * No DOM, no transport, no React.
 */
import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api/sessions.ts'
import { type PlanNode } from './contract.ts'
import { type BoardSnapshot, readTodos, stateOf } from './bridge.ts'

/** Kind of graph node; each kind has its own card size and handle set. */
export type FlowNodeKind = 'mission' | 'agent' | 'task'

/**
 * One status vocabulary for both sources: board run states and todo-tree task
 * states. Colour mapping lives in CSS, never here.
 */
export type FlowStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'stalemate'
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled'

/** Every node kind, in card-size order. */
export const FLOW_KINDS: readonly FlowNodeKind[] = ['mission', 'agent', 'task']

/** Legend and inspector ordering, live work first. */
export const FLOW_STATUS_ORDER: readonly FlowStatus[] = [
  'running',
  'in_progress',
  'blocked',
  'verifying',
  'queued',
  'pending',
  'done',
  'completed',
  'failed',
  'stalemate',
  'cancelled',
]

/** One connection point on a node card. */
export interface FlowPort {
  /** Handle id, unique within the node and referenced by `FlowEdge.sourceHandle`/`targetHandle`. */
  id: string
  /** Side of the card the handle sits on. */
  side: 'input' | 'output'
  /** Port label shown beside the handle dot. */
  label: string
}

/** One node card. Field names mirror Langflow's node vocabulary. */
export interface FlowNode {
  /** Graph-unique id (`mission:<sessionId>`, `task:<sessionId>#0.1`). */
  id: string
  kind: FlowNodeKind
  /** Session the node was derived from. */
  sessionId: string
  /** Depth-first child-index path inside the mission; empty for missions and agents. */
  path: string
  /** Card title. */
  label: string
  /** Secondary line: the session id, or the subtask position for tasks. */
  subtitle: string
  /** Node lifecycle state. */
  status: FlowStatus
  /** Parent node id, or null for a root node. */
  parentId: string | null
  /** Column index from the left. */
  depth: number
  /** Stable sibling ordering within the parent. */
  order: number
  /** Incoming handles (left edge). */
  inputs: FlowPort[]
  /** Outgoing handles (right edge). */
  outputs: FlowPort[]
}

/** One edge; connections always run `output → input`, as in Langflow. */
export interface FlowEdge {
  /** Graph-unique id, stable across polls. */
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
  /** True while the source does live work, so the canvas animates the flow. */
  animated: boolean
}

/** The whole graph: nodes plus edges, with no positions. */
export interface FlowGraph {
  nodes: FlowNode[]
  edges: FlowEdge[]
}

/** A node's resolved box on the canvas plane. */
export interface FlowBox {
  x: number
  y: number
  width: number
  height: number
}

/** Canvas viewport: plane→screen is `screen = plane * scale + translate`. */
export interface FlowView {
  x: number
  y: number
  scale: number
}

/** A point, on the canvas plane or in screen pixels depending on context. */
export interface FlowPoint {
  x: number
  y: number
}

/** Axis-aligned bounds on the canvas plane. */
export interface FlowBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Card size per node kind: missions are widest, tasks the most compact. */
const SIZES: Record<FlowNodeKind, { width: number; height: number }> = {
  mission: { width: 232, height: 72 },
  agent: { width: 208, height: 64 },
  task: { width: 176, height: 44 },
}

/** Horizontal gap between layout columns. */
const COLUMN_GAP = 96

/** Vertical gap between stacked cards in one column. */
const ROW_GAP = 20

/** Lower zoom bound. */
export const MIN_SCALE = 0.2

/** Upper zoom bound. */
export const MAX_SCALE = 2.5

/** Handle ids per kind: one input on the left, one output on the right. */
const PORT_IDS: Record<FlowNodeKind, { input: string; output: string }> = {
  mission: { input: 'in', output: 'plan' },
  agent: { input: 'in', output: 'plan' },
  task: { input: 'in', output: 'out' },
}

/** Fixed class key per kind, so the canvas picks a CSS class without branching. */
export const FLOW_KIND_CLASS: Record<FlowNodeKind, string> = {
  mission: 'kindMission',
  agent: 'kindAgent',
  task: 'kindTask',
}

/** Fixed class key per status, so the canvas picks a CSS class without branching. */
export const FLOW_STATUS_CLASS: Record<FlowStatus, string> = {
  queued: 'statusQueued',
  running: 'statusRunning',
  blocked: 'statusBlocked',
  verifying: 'statusVerifying',
  done: 'statusDone',
  failed: 'statusFailed',
  stalemate: 'statusStalemate',
  pending: 'statusPending',
  in_progress: 'statusInProgress',
  completed: 'statusCompleted',
  cancelled: 'statusCancelled',
}

/** Statuses that count as live work: their edges animate and their cards pulse. */
const LIVE: readonly FlowStatus[] = ['running', 'in_progress']

/**
 * Card size for a node kind.
 * @param kind - Node kind.
 * @returns The card width and height in canvas units.
 */
export function nodeSize(kind: FlowNodeKind): { width: number; height: number } {
  return SIZES[kind]
}

/**
 * Restricts a zoom factor to the supported range.
 * @param scale - Requested scale.
 * @returns The scale clamped to `[MIN_SCALE, MAX_SCALE]`.
 */
export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/**
 * Whether a status represents live work.
 * @param status - Status to test.
 * @returns True when a node in this status is doing work right now.
 */
export function isLiveStatus(status: FlowStatus): boolean {
  return LIVE.includes(status)
}

/** The handle arrays a node of this kind renders, one port per side. */
function portsOf(kind: FlowNodeKind): { inputs: FlowPort[]; outputs: FlowPort[] } {
  const ids = PORT_IDS[kind]
  return {
    inputs: [{ id: ids.input, side: 'input', label: ids.input }],
    outputs: [{ id: ids.output, side: 'output', label: ids.output }],
  }
}

/** Builds one node, carrying its kind's handle set. */
function makeNode(
  kind: FlowNodeKind,
  sessionId: string,
  path: string,
  label: string,
  subtitle: string,
  status: FlowStatus,
  parentId: string | null,
  depth: number,
  order: number,
): FlowNode {
  const id = kind === 'task' ? `task:${sessionId}#${path}` : `${kind}:${sessionId}`
  return { id, kind, sessionId, path, label, subtitle, status, parentId, depth, order, ...portsOf(kind) }
}

/** The edge from a node's single output into the single input of another node. */
function link(source: FlowNode, target: FlowNode): FlowEdge {
  const sourceHandle = PORT_IDS[source.kind].output
  const targetHandle = PORT_IDS[target.kind].input
  return {
    id: `${source.id}:${sourceHandle}->${target.id}:${targetHandle}`,
    source: source.id,
    sourceHandle,
    target: target.id,
    targetHandle,
    animated: isLiveStatus(source.status),
  }
}

/**
 * Walks one session's nested todo tree into task nodes and parent→child edges.
 * A node's path is its depth-first child-index chain (`0`, `0.1`, `2`), so ids
 * stay stable across polls and never collide across sessions.
 * @param todos - Nested todo tree, already read off the wire.
 * @param sessionId - Owning session.
 * @param parent - Node the top level of `todos` hangs from.
 * @param nodes - Accumulator for created task nodes.
 * @param edges - Accumulator for created task edges.
 */
function addTasks(
  todos: readonly PlanNode[],
  sessionId: string,
  parent: FlowNode,
  nodes: FlowNode[],
  edges: FlowEdge[],
): void {
  todos.forEach((todo, index) => {
    const path = parent.path === '' ? String(index) : `${parent.path}.${index}`
    const task = makeNode('task', sessionId, path, todo.content, `task ${path}`, todo.status, parent.id, parent.depth + 1, index)
    nodes.push(task)
    edges.push(link(parent, task))
    if (todo.children !== undefined) addTasks(todo.children, sessionId, task, nodes, edges)
  })
}

/** Options for {@link buildFlow}. */
export interface BuildFlowOptions {
  /** Comparison instant for the queued/done recency fallback. */
  now?: number
  /** Overlays human-facing titles (runtime sessions service) onto node labels. */
  titles?: ReadonlyMap<string, string>
  /** Emit task nodes from the todo tree; default true. */
  includeTasks?: boolean
}

/**
 * Builds the Dag Flow graph from one board snapshot.
 *
 * Placement mirrors the board's run derivation: each workspace's non-subagent
 * sessions become mission nodes in the workspace's owned order; sessions with
 * `origin: 'subagent'` and a `parentSessionId` become agent nodes under that
 * mission; archived sessions never render. Each mission's nested todo tree
 * becomes task nodes one column to its right. A subagent whose parent is not on
 * the board still renders, as a root.
 * @param board - One `orchestrator.board` snapshot.
 * @param opts - Comparison instant, title overlay, and task-node switch.
 * @returns Missions, spawned agents, and plan tasks with their edges.
 */
export function buildFlow(board: BoardSnapshot, opts: BuildFlowOptions = {}): FlowGraph {
  const now = opts.now ?? Date.now()
  const titles = opts.titles ?? new Map<string, string>()
  const includeTasks = opts.includeTasks ?? true
  const archived = new Set<string>(board.archivedSessionIds)
  const byId = new Map<string, SessionSummary>(
    board.sessions.filter(s => !archived.has(s.sessionId)).map(s => [s.sessionId, s]),
  )
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const placed = new Set<string>()

  /** Adds one session node, its incoming edge, and its nested task tree. */
  const place = (
    summary: SessionSummary,
    kind: 'mission' | 'agent',
    order: number,
    parent: FlowNode | null,
  ): FlowNode => {
    placed.add(summary.sessionId)
    const node = makeNode(
      kind,
      summary.sessionId,
      '',
      titles.get(summary.sessionId) ?? summary.sessionId,
      summary.sessionId,
      stateOf(summary, now),
      parent === null ? null : parent.id,
      parent === null ? 0 : 1,
      order,
    )
    nodes.push(node)
    if (parent !== null) edges.push(link(parent, node))
    const todos = includeTasks ? readTodos(summary) : undefined
    if (todos !== undefined) addTasks(todos, summary.sessionId, node, nodes, edges)
    return node
  }

  const childrenOf = (sessionId: string): SessionSummary[] =>
    [...byId.values()].filter(c => c.origin === 'subagent' && c.parentSessionId === sessionId)

  for (const workspace of board.items) {
    for (const sessionId of workspace.sessionIds) {
      const summary = byId.get(sessionId)
      if (summary === undefined || summary.origin === 'subagent' || placed.has(summary.sessionId)) continue
      const mission = place(summary, 'mission', nodes.length, null)
      childrenOf(summary.sessionId).forEach((child, index) => place(child, 'agent', index, mission))
    }
  }
  for (const summary of byId.values()) {
    if (summary.origin === 'subagent' && !placed.has(summary.sessionId)) {
      place(summary, 'agent', nodes.length, null)
    }
  }
  return { nodes, edges }
}

/**
 * Langflow's connection rule, used to highlight compatible handles: an output
 * may only meet an input, both ports must exist on their nodes, and a node
 * never links to itself.
 * @param graph - Graph the ports belong to.
 * @param connection - Attempted connection.
 * @returns True when the connection is structurally valid.
 */
export function isValidConnection(
  graph: FlowGraph,
  connection: { source: string; sourceHandle: string; target: string; targetHandle: string },
): boolean {
  if (connection.source === connection.target) return false
  const source = graph.nodes.find(n => n.id === connection.source)
  const target = graph.nodes.find(n => n.id === connection.target)
  if (source === undefined || target === undefined) return false
  const out = source.outputs.find(p => p.id === connection.sourceHandle)
  const into = target.inputs.find(p => p.id === connection.targetHandle)
  return out !== undefined && into !== undefined
}

/**
 * Layered left-to-right layout: one column per depth, cards stacked in
 * discovery order, then every parent re-centred on the vertical span of its
 * children so edges fan out symmetrically.
 * @param graph - Graph to lay out.
 * @param opts - Column gap and row gap overrides.
 * @returns One box per node id.
 */
export function layoutFlow(
  graph: FlowGraph,
  opts: { columnGap?: number; rowGap?: number } = {},
): Map<string, FlowBox> {
  const columnGap = opts.columnGap ?? COLUMN_GAP
  const rowGap = opts.rowGap ?? ROW_GAP
  const byDepth = new Map<number, FlowNode[]>()
  for (const node of graph.nodes) {
    const column = byDepth.get(node.depth)
    if (column === undefined) byDepth.set(node.depth, [node])
    else column.push(node)
  }
  const placed: Array<{ node: FlowNode; box: FlowBox }> = []
  let x = 0
  for (const [, nodes] of [...byDepth.entries()].sort(([a], [b]) => a - b)) {
    const left = x
    x += Math.max(...nodes.map(n => nodeSize(n.kind).width)) + columnGap
    let y = 0
    for (const node of nodes) {
      const size = nodeSize(node.kind)
      const box: FlowBox = { x: left, y, width: size.width, height: size.height }
      placed.push({ node, box })
      y += size.height + rowGap
    }
  }
  // Deepest columns first, so grandchildren settle before their parents centre.
  for (const { node, box } of [...placed].sort((a, b) => b.node.depth - a.node.depth)) {
    const kids = placed.filter(entry => entry.node.parentId === node.id)
    if (kids.length === 0) continue
    const top = Math.min(...kids.map(entry => entry.box.y))
    const bottom = Math.max(...kids.map(entry => entry.box.y + entry.box.height))
    box.y = (top + bottom) / 2 - box.height / 2
  }
  return new Map(placed.map(entry => [entry.node.id, entry.box]))
}

/**
 * Bisects a graph with its layout into the pairs the canvas draws. Nodes the
 * layout did not place are dropped, so render code never re-checks a lookup.
 * @param graph - Graph to render.
 * @param boxes - Layout boxes for that graph.
 * @returns Every node that has a box, with its box.
 */
export function placedNodes(graph: FlowGraph, boxes: Map<string, FlowBox>): Array<{ node: FlowNode; box: FlowBox }> {
  const placed: Array<{ node: FlowNode; box: FlowBox }> = []
  for (const node of graph.nodes) {
    const box = boxes.get(node.id)
    if (box !== undefined) placed.push({ node, box })
  }
  return placed
}

/** One drawable edge: its path plus the facts that style it. */
export interface FlowEdgeShape {
  id: string
  /** SVG path `d` between the source's output handle and the target's input handle. */
  d: string
  /** Status of the source node, which the canvas maps to a status class. */
  status: FlowStatus
  /** True when the edge should animate. */
  animated: boolean
}

/**
 * Resolves every edge into a drawable path. An edge whose endpoints are absent
 * from the graph or from the layout is dropped.
 * @param graph - Graph to render.
 * @param boxes - Layout boxes for that graph.
 * @returns One shape per drawable edge.
 */
export function edgeShapes(graph: FlowGraph, boxes: Map<string, FlowBox>): FlowEdgeShape[] {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const shapes: FlowEdgeShape[] = []
  for (const edge of graph.edges) {
    const source = byId.get(edge.source)
    const from = boxes.get(edge.source)
    const to = boxes.get(edge.target)
    if (source === undefined || from === undefined || to === undefined) continue
    shapes.push({
      id: edge.id,
      d: bezierPath(handlePoint(from, 'output'), handlePoint(to, 'input')),
      status: source.status,
      animated: edge.animated,
    })
  }
  return shapes
}

/**
 * Bounding box over a set of node boxes.
 * @param boxes - Boxes to measure; an empty set yields a zero box at the origin.
 * @returns The enclosing bounds.
 */
export function boundsOf(boxes: Iterable<FlowBox>): FlowBounds {
  const all = [...boxes]
  if (all.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return {
    minX: Math.min(...all.map(b => b.x)),
    minY: Math.min(...all.map(b => b.y)),
    maxX: Math.max(...all.map(b => b.x + b.width)),
    maxY: Math.max(...all.map(b => b.y + b.height)),
  }
}

/**
 * Anchor point of one handle: input handles sit on the card's left edge,
 * output handles on its right edge, both vertically centred.
 * @param box - The node's box.
 * @param side - Which edge the handle belongs to.
 * @returns The handle's canvas-plane coordinate.
 */
export function handlePoint(box: FlowBox, side: 'input' | 'output'): FlowPoint {
  return { x: side === 'input' ? box.x : box.x + box.width, y: box.y + box.height / 2 }
}

/**
 * Cubic bezier between two handles, with horizontal control points so edges
 * leave an output and enter an input perpendicular to the card edge.
 * @param from - Source (output) anchor.
 * @param to - Target (input) anchor.
 * @returns An SVG path `d` string.
 */
export function bezierPath(from: FlowPoint, to: FlowPoint): string {
  const distance = Math.max(32, Math.abs(to.x - from.x) * 0.5)
  return `M ${from.x},${from.y} C ${from.x + distance},${from.y} ${to.x - distance},${to.y} ${to.x},${to.y}`
}

/**
 * Zooms about a screen point, keeping the plane point under the cursor fixed.
 * @param view - Current viewport.
 * @param factor - Multiplicative zoom factor.
 * @param point - Cursor position in screen coordinates, relative to the canvas.
 * @returns The new viewport.
 */
export function zoomAt(view: FlowView, factor: number, point: FlowPoint): FlowView {
  const scale = clampScale(view.scale * factor)
  const ratio = scale / view.scale
  return {
    scale,
    x: point.x - (point.x - view.x) * ratio,
    y: point.y - (point.y - view.y) * ratio,
  }
}

/**
 * Fits bounds into a viewport size with padding, never magnifying past 1.
 * @param bounds - Plane bounds to fit.
 * @param size - Viewport size in screen pixels.
 * @param padding - Screen padding to leave on every side.
 * @returns The viewport that centres the bounds.
 */
export function fitView(bounds: FlowBounds, size: FlowPoint, padding = 48): FlowView {
  const width = Math.max(1, bounds.maxX - bounds.minX)
  const height = Math.max(1, bounds.maxY - bounds.minY)
  const scale = clampScale(Math.min(1, (size.x - padding * 2) / width, (size.y - padding * 2) / height))
  return {
    scale,
    x: (size.x - width * scale) / 2 - bounds.minX * scale,
    y: (size.y - height * scale) / 2 - bounds.minY * scale,
  }
}

/**
 * Moves the viewport by a screen-space delta.
 * @param view - Current viewport.
 * @param dx - Horizontal delta in screen pixels.
 * @param dy - Vertical delta in screen pixels.
 * @returns The panned viewport.
 */
export function panBy(view: FlowView, dx: number, dy: number): FlowView {
  return { ...view, x: view.x + dx, y: view.y + dy }
}

/**
 * Projects a screen point back onto the canvas plane.
 * @param view - Current viewport.
 * @param point - Screen coordinate relative to the canvas.
 * @returns The plane coordinate under that screen point.
 */
export function toPlane(view: FlowView, point: FlowPoint): FlowPoint {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale }
}

/**
 * Centres a plane point in a viewport of the given size, keeping the scale.
 * @param view - Current viewport.
 * @param point - Plane point to put at the viewport's centre.
 * @param size - Viewport size in screen pixels.
 * @returns The recentred viewport.
 */
export function centreOn(view: FlowView, point: FlowPoint, size: FlowPoint): FlowView {
  return { scale: view.scale, x: size.x / 2 - point.x * view.scale, y: size.y / 2 - point.y * view.scale }
}

/**
 * Scale factor that fits plane bounds into a minimap box, never magnifying.
 * @param bounds - Plane bounds to fit.
 * @param size - Minimap size in pixels.
 * @param padding - Padding left inside the minimap on every side.
 * @returns The minimap scale factor.
 */
export function minimapScale(bounds: FlowBounds, size: FlowPoint, padding = 6): number {
  const width = Math.max(1, bounds.maxX - bounds.minX)
  const height = Math.max(1, bounds.maxY - bounds.minY)
  return Math.min((size.x - padding * 2) / width, (size.y - padding * 2) / height, 1)
}
