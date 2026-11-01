/**
 * The flowbuilder run scheduler: Kahn-style wave execution over a saved
 * definition with data-driven parallelism (every ready node in a wave runs
 * concurrently), condition-branch pruning to `skipped`, and fail-fast error
 * propagation. All persistence and code execution cross the {@link RunHost}
 * seam, so the scheduler is unit-testable without storage or a runtime; the
 * service owns durability ordering (every put lands before its event).
 *
 * @module @deepseek-ai/dsh-flowbuilder-service/engine
 */

import type {
  BlockLibraryEntryRecord,
  FlowDefinitionRecord,
  FlowEdge,
  FlowNode,
  FlowNodeRunState,
  FlowRunRecordRecord,
} from '@deepseek-ai/dsh-flowbuilder-domain'

/** How far a `library` node may chain into further blocks before refusing. */
const MAX_LIBRARY_DEPTH = 8

/** The execution services the scheduler needs from the owning service. */
export interface RunHost {
  /** Durably store one whole-record snapshot; called before any event for it. */
  putRecord(record: FlowRunRecordRecord): Promise<void>
  /** Emit the per-node transition after its {@link RunHost.putRecord} lands. */
  onNodeState(runId: FlowRunRecordRecord['id'], nodeId: string, state: FlowNodeRunState): void
  /** Resolve one library block for `library` nodes. */
  getBlock(blockId: string): BlockLibraryEntryRecord | undefined
  /** Run one code/condition program; rejects with the failure message. */
  runCode(
    program: string,
    params: Record<string, string | number | boolean | null>,
    inputs: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown>
  /** One completion through the composed LLM routes; resolves the assistant text. */
  runLlm(
    options: { provider: string; model: string; prompt: string; system?: string; signal: AbortSignal | undefined },
  ): Promise<string>
  /** Retrieve one URL through the web capability. */
  fetchUrl(url: string, signal: AbortSignal | undefined): Promise<{ statusCode: number; body: string }>
  /** Run one shell command; resolves the captured stdout. */
  runShellCommand(command: string, signal: AbortSignal | undefined): Promise<{ exitCode: number | null; stdout: string }>
}

/**
 * Render `{{port}}` templates against the node's live inputs: string values
 * interpolate verbatim, everything else as lossless JSON.
 * @param template - the raw template text.
 * @param inputs - live input values keyed by target port name.
 * @returns the rendered text.
 */
export function renderTemplate(template: string, inputs: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, name: string) => {
    const value = inputs[name]
    if (value === undefined) return `{{${name}}}`
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

/** Why one node failure.failed, rendered for the run record and the tool result. */
function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The first live input value, or `null` when the node has no live inputs. */
function firstInput(inputs: Record<string, unknown>): unknown {
  const first = Object.keys(inputs)[0]
  return first === undefined ? null : inputs[first]
}

/** One node program's outcome. */
type EdgeState = 'live' | 'dead' | 'unresolved'

/**
 * Run one saved definition to a terminal record. Never rejects: an
 * unexpected internal failure persists a terminal `error` record and returns
 * it, so the fire-and-forget caller only handles the returned terminal.
 * @param host - the execution seam (persistence, events, code runtime).
 * @param flow - the saved definition being run (structurally valid).
 * @param initial - the durable `running` record the run started from.
 * @param signal - cancellation for the whole run.
 * @returns the terminal record as persisted.
 */
export async function executeRun(
  host: RunHost,
  flow: FlowDefinitionRecord,
  initial: FlowRunRecordRecord,
  signal?: AbortSignal,
): Promise<FlowRunRecordRecord> {
  try {
    return await runGraph(host, flow, initial, signal)
  } catch (error) {
    const terminal: FlowRunRecordRecord = {
      ...initial,
      status: 'error',
      finishedAt: new Date().toISOString(),
      error: `run engine failed: ${renderError(error)}`,
    }
    await host.putRecord(terminal)
    return terminal
  }
}

/** The wave scheduler proper; see {@link executeRun} for the contract. */
async function runGraph(
  host: RunHost,
  flow: FlowDefinitionRecord,
  initial: FlowRunRecordRecord,
  signal?: AbortSignal,
): Promise<FlowRunRecordRecord> {
  const nodesById = new Map(flow.nodes.map(node => [node.id, node]))
  const incoming = new Map<string, FlowEdge[]>()
  for (const edge of flow.edges) {
    const list = incoming.get(edge.to.nodeId)
    if (list === undefined) incoming.set(edge.to.nodeId, [edge])
    else list.push(edge)
  }

  const nodes: Record<string, FlowNodeRunState> = Object.fromEntries(
    Object.entries(initial.nodes).map(([id, state]) => [id, { ...state }]),
  )
  const snapshot = (): FlowRunRecordRecord => ({ ...initial, nodes: { ...nodes } })
  const persistNode = async (nodeId: string, state: FlowNodeRunState): Promise<void> => {
    nodes[nodeId] = state
    await host.putRecord(snapshot())
    host.onNodeState(initial.id, nodeId, state)
  }

  const outputs = new Map<string, unknown>()
  const verdicts = new Map<string, boolean>()
  let result: unknown
  let lastOutput: unknown
  // runNode records the first node failure here; the scheduling loop below
  // reads it, so the state lives on a holder rather than a captured binding.
  const failure: { failed: boolean; message?: string } = { failed: false }

  /**
   * Classify one edge against its source's settlement: `unresolved` while the
   * source is pending or running, `dead` when the source failure.failed or the edge's
   * condition port lost the branch, `live` when the value may flow.
   */
  const edgeState = (edge: FlowEdge): EdgeState => {
    const state = nodes[edge.from.nodeId]
    if (state === undefined) return 'dead'
    if (state.status === 'completed') {
      if (nodesById.get(edge.from.nodeId)?.kind !== 'condition') return 'live'
      const verdict = verdicts.get(edge.from.nodeId)
      if (verdict === undefined) return 'unresolved'
      return verdict === (edge.from.port !== 'false') ? 'live' : 'dead'
    }
    if (state.status === 'skipped') return 'dead'
    return 'unresolved'
  }

  const runNode = async (node: FlowNode, edges: FlowEdge[]): Promise<void> => {
    const inputs: Record<string, unknown> = {}
    for (const edge of edges) {
      if (edgeState(edge) !== 'live') continue
      inputs[edge.to.port] = outputs.get(edge.from.nodeId) ?? null
    }
    await persistNode(node.id, { status: 'running' })
    try {
      const output = await executeNode(host, node, node.params, inputs, signal, 0)
      outputs.set(node.id, output)
      if (node.kind === 'condition') verdicts.set(node.id, Boolean(output))
      if (node.kind === 'output') result = output
      else if (output !== null) lastOutput = output
      await persistNode(node.id, { status: 'completed', output })
    } catch (error) {
      const message = renderError(error)
      await persistNode(node.id, { status: 'error', error: message })
      failure.failed = true
      failure.message = message
    }
  }

  let progress: boolean = true
  while (progress && !failure.failed && signal?.aborted !== true) {
    const before = Object.values(nodes).filter(state => state.status !== 'pending').length
    const ready = flow.nodes.filter((node) => {
      if (nodes[node.id]?.status !== 'pending') return false
      const states = (incoming.get(node.id) ?? []).map(edgeState)
      return !states.includes('unresolved')
    })
    const active: Promise<void>[] = []
    for (const node of ready) {
      const edges = incoming.get(node.id) ?? []
      // A node with no incoming edges (an input source) is always runnable;
      // otherwise every incoming path losing its branch skips the node.
      const dead = edges.length > 0 && !edges.map(edgeState).includes('live')
      if (dead) {
        await persistNode(node.id, { status: 'skipped' })
        continue
      }
      active.push(runNode(node, edges))
    }
    await Promise.all(active)
    const after = Object.values(nodes).filter(state => state.status !== 'pending').length
    progress = after > before
  }

  for (const node of flow.nodes) {
    if (nodes[node.id]?.status === 'pending') await persistNode(node.id, { status: 'skipped' })
  }

  const cancelled = !failure.failed && signal?.aborted === true
  const terminal: FlowRunRecordRecord = {
    ...snapshot(),
    status: failure.failed ? 'error' : cancelled ? 'cancelled' : 'completed',
    finishedAt: new Date().toISOString(),
    ...failure.failed ? { error: failure.message } : {},
    ...!failure.failed && !cancelled ? { result: result ?? lastOutput ?? null } : {},
  }
  await host.putRecord(terminal)
  return terminal
}

/**
 * Execute one node. `library` nodes resolve their block and recurse into the
 * block's kind (node code and params win over the block's); the depth guard
 * refuses library chains before they can recurse without bound.
 * @param host - the execution seam.
 * @param node - the node being executed (kind, code, params).
 * @param nodeParams - the effective params (block defaults merged by callers).
 * @param inputs - live input values keyed by target port name.
 * @param signal - the run's cancellation.
 * @param depth - current library indirection depth.
 * @returns the node's output value.
 */
async function executeNode(
  host: RunHost,
  node: FlowNode,
  nodeParams: Record<string, string | number | boolean | null>,
  inputs: Record<string, unknown>,
  signal: AbortSignal | undefined,
  depth: number,
): Promise<unknown> {
  switch (node.kind) {
    case 'input':
      return nodeParams.value ?? null
    case 'output':
    case 'transform':
      return firstInput(inputs)
    case 'code':
    case 'condition': {
      const program = node.code
      if (program === undefined || program.trim().length === 0) {
        throw new Error(`a ${node.kind} node carries no code`)
      }
      const value = await host.runCode(program, nodeParams, inputs, signal)
      if (node.kind !== 'condition') return value
      // Truthiness by explicit rejects only: the conditioned ports are
      // `true`/`false`, so only the falsy primitives prune the true branch.
      return value !== false && value !== null && value !== 0 && value !== ''
    }
    case 'library': {
      if (node.blockId === undefined) throw new Error('a library node names no block')
      if (depth >= MAX_LIBRARY_DEPTH) {
        throw new Error(`library chain deeper than ${MAX_LIBRARY_DEPTH} at block '${node.blockId}'`)
      }
      const block = host.getBlock(node.blockId)
      if (block === undefined) throw new Error(`library block '${node.blockId}' is not in the library`)
      const defaults = Object.fromEntries(
        block.params
          .map(param => [param.name, param.default])
          .filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined),
      )
      return executeNode(
        host,
        { ...node, kind: block.kind, code: node.code ?? block.code },
        { ...defaults, ...nodeParams },
        inputs,
        signal,
        depth + 1,
      )
    }
    case 'llm': {
      const provider = nodeParams.provider
      const model = nodeParams.model
      if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
        throw new Error('an llm node carries no provider/model params')
      }
      const promptTemplate = nodeParams.prompt
      if (typeof promptTemplate !== 'string' || promptTemplate.length === 0) {
        throw new Error('an llm node carries no prompt param')
      }
      const systemParam = nodeParams.system
      return host.runLlm({
        provider,
        model,
        prompt: renderTemplate(promptTemplate, inputs),
        ...typeof systemParam === 'string' && systemParam.length > 0
          ? { system: renderTemplate(systemParam, inputs) }
          : {},
        signal,
      })
    }
    case 'http': {
      const url = nodeParams.url
      if (typeof url !== 'string' || url.length === 0) throw new Error('an http node carries no url param')
      const fetched = await host.fetchUrl(renderTemplate(url, inputs), signal)
      return { statusCode: fetched.statusCode, body: fetched.body }
    }
    case 'shell': {
      const command = nodeParams.command
      if (typeof command !== 'string' || command.length === 0) throw new Error('a shell node carries no command param')
      const ran = await host.runShellCommand(renderTemplate(command, inputs), signal)
      if (ran.exitCode !== 0) {
        throw new Error(`command exited ${String(ran.exitCode)}: ${ran.stdout.slice(0, 400)}`)
      }
      return { exitCode: ran.exitCode, stdout: ran.stdout }
    }
    case 'agent':
      throw new Error("node kind 'agent' has no executor in this build (a run outside an agent turn cannot spawn children)")
  }
}
