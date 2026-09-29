/**
 * Pure flow-graph validation: structural integrity and acyclicity for one
 * definition's nodes and edges. The service's save path and the model tools
 * both call this before any write, so an invalid graph never reaches the
 * domain and the rejection message is stable across every consumer.
 *
 * @module @deepseek-ai/dsh-flowbuilder-domain/dag
 */

import type { FlowEdge, FlowNode } from './types.ts'

/** The outcome of one structural validation. */
export interface DagValidation {
  /** Whether the graph may be persisted and executed. */
  ok: boolean
  /** The first rejection, human-readable and node/edge-addressed, when invalid. */
  error?: string
}

/**
 * Validate one flow graph's structure: unique node and edge ids, edge
 * endpoints that resolve, at most one incoming edge per target port, a
 * `blockId` on exactly the `library` nodes, and no cycles.
 * @param nodes - the definition's nodes.
 * @param edges - the definition's edges.
 * @returns `{ ok: true }`, or the first violation.
 */
export function validateFlowStructure(nodes: FlowNode[], edges: FlowEdge[]): DagValidation {
  const byId = new Map<string, FlowNode>()
  for (const node of nodes) {
    if (byId.has(node.id)) return { ok: false, error: `duplicate node id "${node.id}"` }
    byId.set(node.id, node)
  }
  const edgeIds = new Set<string>()
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) return { ok: false, error: `duplicate edge id "${edge.id}"` }
    edgeIds.add(edge.id)
    if (!byId.has(edge.from.nodeId)) {
      return { ok: false, error: `edge "${edge.id}" references missing source node "${edge.from.nodeId}"` }
    }
    if (!byId.has(edge.to.nodeId)) {
      return { ok: false, error: `edge "${edge.id}" references missing target node "${edge.to.nodeId}"` }
    }
  }
  const incoming = new Map<string, number>()
  for (const edge of edges) {
    const target = `${edge.to.nodeId}/${edge.to.port}`
    if ((incoming.get(target) ?? 0) > 0) {
      return { ok: false, error: `port "${edge.to.nodeId}/${edge.to.port}" receives more than one edge` }
    }
    incoming.set(target, (incoming.get(target) ?? 0) + 1)
  }
  for (const node of nodes) {
    if (node.kind === 'library' && node.blockId === undefined) {
      return { ok: false, error: `library node "${node.id}" carries no blockId` }
    }
    if (node.kind !== 'library' && node.blockId !== undefined) {
      return { ok: false, error: `node "${node.id}" carries blockId but its kind is "${node.kind}"` }
    }
  }
  return detectCycle(nodes, edges)
}

/**
 * Reject cyclic graphs with Kahn's algorithm: a graph whose topological
 * removal cannot consume every node contains a cycle.
 * @param nodes - the definition's nodes.
 * @param edges - the definition's edges.
 * @returns `{ ok: true }`, or the first node left unconsumed, addressed.
 */
function detectCycle(nodes: FlowNode[], edges: FlowEdge[]): DagValidation {
  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const node of nodes) {
    indegree.set(node.id, 0)
    outgoing.set(node.id, [])
  }
  for (const edge of edges) {
    indegree.set(edge.to.nodeId, (indegree.get(edge.to.nodeId) ?? 0) + 1)
    // Every node id was seeded above, so the bucket always exists.
    outgoing.get(edge.from.nodeId)?.push(edge.to.nodeId)
  }
  let queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id)
  let consumed = 0
  while (queue.length > 0) {
    const next: string[] = []
    for (const id of queue) {
      consumed += 1
      for (const target of outgoing.get(id) ?? []) {
        const remaining = (indegree.get(target) ?? 0) - 1
        indegree.set(target, remaining)
        if (remaining === 0) next.push(target)
      }
    }
    queue = next
  }
  if (consumed < nodes.length) {
    const stuck = nodes.map(node => node.id).find(id => (indegree.get(id) ?? 0) > 0)
    return { ok: false, error: `graph contains a cycle through node "${stuck ?? '?'}"` }
  }
  return { ok: true }
}
