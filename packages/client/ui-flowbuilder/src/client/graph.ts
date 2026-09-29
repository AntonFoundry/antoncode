/**
 * Pure graph model of the Workflows canvas: the editable draft (definition
 * nodes + edges), its mutation operations, and run-state projection. No React,
 * no wire client — the component shell drives these with plain data.
 * @module ui-flowbuilder/graph
 */

/** One draft node (wire shape reused verbatim). */
export interface DraftNode {
  id: string
  kind: string
  title: string
  blockId?: string
  params: Record<string, unknown>
  code?: string
  x: number
  y: number
}

/** One draft edge. */
export interface DraftEdge {
  id: string
  from: { nodeId: string; port: string }
  to: { nodeId: string; port: string }
}

/** The editable graph draft. */
export interface FlowDraft {
  id?: string
  name: string
  description: string
  nodes: DraftNode[]
  edges: DraftEdge[]
}

/** The ten palette kinds and their default titles. */
export const PALETTE_KINDS: readonly { kind: string; title: string }[] = [
  { kind: 'input', title: 'Input' },
  { kind: 'output', title: 'Output' },
  { kind: 'code', title: 'Code' },
  { kind: 'llm', title: 'LLM' },
  { kind: 'agent', title: 'Agent' },
  { kind: 'shell', title: 'Shell' },
  { kind: 'http', title: 'HTTP' },
  { kind: 'condition', title: 'Condition' },
  { kind: 'transform', title: 'Transform' },
  { kind: 'library', title: 'Library' },
]

/** Rendered node card geometry (px). */
export const NODE_W = 180
export const NODE_H = 56

/** Fresh minted draft ids, unique within a draft. */
let draftCounter = 0

/** Mint one locally unique draft id. */
export function freshId(prefix: string): string {
  draftCounter += 1
  return `${prefix}-${String(draftCounter)}-${Math.random().toString(36).slice(2, 7)}`
}

/** An empty draft with one input and one output node. */
export function emptyDraft(): FlowDraft {
  return {
    name: 'Untitled workflow',
    description: '',
    nodes: [
      { id: freshId('in'), kind: 'input', title: 'Input', params: {}, x: 40, y: 60 },
      { id: freshId('out'), kind: 'output', title: 'Output', params: {}, x: 320, y: 60 },
    ],
    edges: [],
  }
}

/** Convert a stored wire record into an editable draft. */
export function draftOf(flow: { id: string; name: string; description: string; nodes: DraftNode[]; edges: DraftEdge[] }): FlowDraft {
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    nodes: flow.nodes.map(node => ({ ...node, params: { ...node.params } })),
    edges: flow.edges.map(edge => ({ ...edge })),
  }
}

/** Add one palette node at a canvas position, returning the new draft. */
export function addNode(draft: FlowDraft, kind: string, x: number, y: number): FlowDraft {
  const palette = PALETTE_KINDS.find(entry => entry.kind === kind) ?? { kind, title: kind }
  const node: DraftNode = {
    id: freshId(kind),
    kind,
    title: palette.title,
    params: {},
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
  }
  if (kind === 'code') node.code = 'return null'
  return { ...draft, nodes: [...draft.nodes, node] }
}

/** Move one node, returning the new draft (no-op when the id is unknown). */
export function moveNode(draft: FlowDraft, nodeId: string, x: number, y: number): FlowDraft {
  return {
    ...draft,
    nodes: draft.nodes.map(node => (node.id === nodeId
      ? { ...node, x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) }
      : node)),
  }
}

/** Patch one node's editable fields, returning the new draft. */
export function updateNode(
  draft: FlowDraft,
  nodeId: string,
  patch: Partial<Pick<DraftNode, 'title' | 'kind' | 'code' | 'blockId' | 'params'>>,
): FlowDraft {
  return {
    ...draft,
    nodes: draft.nodes.map(node => (node.id === nodeId ? { ...node, ...patch } : node)),
  }
}

/** Remove one node and its edges, returning the new draft. */
export function removeNode(draft: FlowDraft, nodeId: string): FlowDraft {
  return {
    ...draft,
    nodes: draft.nodes.filter(node => node.id !== nodeId),
    edges: draft.edges.filter(edge => edge.from.nodeId !== nodeId && edge.to.nodeId !== nodeId),
  }
}

/**
 * Connect one output port to one input port. An input port accepts at most
 * one edge, and self-edges are refused.
 * @param draft - the draft to extend.
 * @param from - source node and output port.
 * @param to - target node and input port.
 * @returns the new draft, or `undefined` when the connect is refused.
 */
export function connect(
  draft: FlowDraft,
  from: { nodeId: string; port: string },
  to: { nodeId: string; port: string },
): FlowDraft | undefined {
  if (from.nodeId === to.nodeId) return undefined
  if (draft.edges.some(edge => edge.to.nodeId === to.nodeId && edge.to.port === to.port)) return undefined
  if (draft.edges.some(edge => edge.from.nodeId === from.nodeId && edge.from.port === from.port
    && edge.to.nodeId === to.nodeId && edge.to.port === to.port)) return undefined
  return {
    ...draft,
    edges: [...draft.edges, { id: freshId('edge'), from: { ...from }, to: { ...to } }],
  }
}

/** Remove one edge by id, returning the new draft. */
export function disconnect(draft: FlowDraft, edgeId: string): FlowDraft {
  return { ...draft, edges: draft.edges.filter(edge => edge.id !== edgeId) }
}

/** Per-node run projection: status plus the failure message, when errored. */
export interface NodeRunView {
  status: 'pending' | 'running' | 'completed' | 'error' | 'skipped'
  error?: string
}

/**
 * Project one run record's node states onto the draft's nodes.
 * @param nodes - the draft's nodes (only these appear in the result).
 * @param runNodes - the run record's per-node states.
 * @returns one view per draft node (absent run states read as `pending`).
 */
export function applyRunStates(
  nodes: readonly DraftNode[],
  runNodes: Record<string, { status: string; error?: string }>,
): Map<string, NodeRunView> {
  const view = new Map<string, NodeRunView>()
  for (const node of nodes) {
    const state = runNodes[node.id]
    view.set(node.id, state === undefined
      ? { status: 'pending' }
      : { status: state.status as NodeRunView['status'], ...(state.error !== undefined ? { error: state.error } : {}) })
  }
  return view
}

/** Edge endpoint pixel position (output ports right, input ports left). */
export function portPosition(node: DraftNode, side: 'in' | 'out'): { x: number; y: number } {
  return { x: node.x + (side === 'out' ? NODE_W : 0), y: node.y + NODE_H / 2 }
}
