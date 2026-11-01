/**
 * The model-facing `flow.*` tools: author, inspect, and search workflow
 * definitions and the reusable block library behind `ctx.flowBuilder`
 * (`@deepseek-ai/dsh-flowbuilder-service`). Store validation (zod + DAG
 * acyclicity) lives in the service, so every rejection the model sees is the
 * service's own message. Explicit-ask usage guidance is registered as the
 * tools' own prompt section rather than deployment persona prose. Code and
 * condition node programs run on the workspace code runtime and read plain
 * `inputs` (port-name keyed values) and `params` globals.
 * @module @deepseek-ai/dsh-tool-flowbuilder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BlockSaveRequest, FlowSaveRequest } from '@deepseek-ai/dsh-flowbuilder-domain'
// Declaration merges: ctx.flowBuilder and ctx.systemPrompt.
import type {} from '@deepseek-ai/dsh-flowbuilder-service'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-flowbuilder'
export const inject = ['tools', 'flowBuilder', 'systemPrompt']

/** Config: result rendering caps. */
export interface Config {
  /** Rendered-result ceiling, in characters: a longer JSON value is truncated with a notice (default 50000). */
  maxResultChars?: number
}

export const Config: z<Config> = z.object({
  maxResultChars: z.natural().min(1).default(50_000),
})

type ResolvedConfig = Required<Config>

/** The authoring loop guidance, shipped with the tools (never persona prose). */
const SECTION_TEXT = 'When the user describes a repeatable multi-step workflow they want automated — or asks to save, inspect, or organize workflows — author it with the flow_* tools instead of narrating a plan: flow_save writes or updates a workflow definition (it immediately appears on the Dag Flow canvas), flow_block_save authors a reusable block into the shared library, and flow_library_search finds existing blocks to instantiate before writing new code. Keep blocks small and single-purpose; give every node a unique id and connect node ports with edges (each input port accepts one edge). When you save a workflow, tell the user it is on the Dag Flow canvas.'

const NODE_SHAPE = 'Node fields: id (unique), kind (input|output|code|llm|agent|shell|http|condition|transform|library), title, blockId (required for kind=library), params (object, default {}; input nodes carry their literal under value), code (for code/condition: a return-body program reading the plain `inputs` and `params` objects), x, y (canvas position numbers, default 0).'
const EDGE_SHAPE = 'Edge fields: id (unique), from {nodeId, port}, to {nodeId, port} — each target port accepts at most one edge, and the graph must stay acyclic.'

/** Cap a JSON rendering with an explicit truncation notice. */
function clip(rendered: string, maxChars: number): string {
  return rendered.length > maxChars
    ? `${rendered.slice(0, maxChars)}\n… [truncated: ${rendered.length - maxChars} more characters]`
    : rendered
}

/** Render a saved/updated definition as the model-facing text. */
function renderFlowSaved(_args: unknown, value: { flow: JsonValue }): ContentBlock[] {
  const flow = value.flow as { id: string; name: string; nodes: unknown[]; edges: unknown[] }
  return [{
    type: 'text',
    text: `Workflow "${flow.name}" saved (id ${flow.id}, ${flow.nodes.length} nodes, ${flow.edges.length} edges). It is on the Dag Flow canvas.`,
  }]
}

export function apply(ctx: Context, config: Config): void {
  const { maxResultChars } = config as ResolvedConfig
  const service = ctx.flowBuilder

  ctx.systemPrompt.section({
    name: 'tool:flowbuilder',
    order: 116,
    text: SECTION_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'flow_list',
    description: 'List every stored workflow definition (id, name, description, node count, last update).',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { flows: { type: 'json', required: true } } },
      render: (_args, value) => {
        const flows = value.flows as { id: string; name: string; updatedAt: string }[]
        return [{
          type: 'text',
          text: flows.length === 0
            ? 'No workflows stored yet.'
            : flows.map(flow => `- ${flow.name} (${flow.id}, updated ${flow.updatedAt})`).join('\n'),
        }]
      },
    },
    execute() {
      return Promise.resolve({ flows: service.listFlows() as unknown as JsonValue })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'flow_get',
    description: 'Read one stored workflow definition in full (nodes, edges, timestamps) by id.',
    parameters: {
      id: { type: 'string', required: true, description: 'The workflow definition id.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { flow: { type: 'json', required: true } } },
      render: (_args, value) => [{
        type: 'text',
        text: clip(JSON.stringify(value.flow, null, 2), maxResultChars),
      }],
    },
    execute(args) {
      const flow = service.getFlow(args.id)
      if (flow === undefined) return Promise.reject(new Error(`flow '${args.id}' is not stored`))
      return Promise.resolve({ flow: flow as unknown as JsonValue })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'flow_save',
    description: `Create or update one workflow definition (it appears on the Dag Flow canvas). ${NODE_SHAPE} ${EDGE_SHAPE} The graph is validated before anything is written; a rejected save writes nothing.`,
    parameters: {
      id: { type: 'string', description: 'Existing definition id to update; omit to create a new workflow.' },
      name: { type: 'string', required: true, description: 'Human-facing workflow name.' },
      description: { type: 'string', required: true, description: 'One-line description of what the workflow does.' },
      nodes: {
        type: 'array',
        required: true,
        description: NODE_SHAPE,
        items: { type: 'object', additionalProperties: true },
      },
      edges: {
        type: 'array',
        required: true,
        description: EDGE_SHAPE,
        items: { type: 'object', additionalProperties: true },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { flow: { type: 'json', required: true } } },
      render: renderFlowSaved,
    },
    async execute(args) {
      const flow = await service.saveFlow({
        ...args.id !== undefined ? { id: args.id } : {},
        name: args.name,
        description: args.description,
        nodes: args.nodes as unknown as FlowSaveRequest['nodes'],
        edges: args.edges as unknown as FlowSaveRequest['edges'],
      })
      return { flow: flow as unknown as JsonValue }
    },
  }))


  ctx.tools.register(defineTool({
    name: 'flow_run',
    description: 'Start one run of a stored workflow definition. Returns the run id immediately; execution continues asynchronously — poll flow_run_status.',
    parameters: {
      flowId: { type: 'string', required: true, description: 'The workflow definition id to run.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { runId: { type: 'json', required: true } } },
      render: (_args, value) => [{
        type: 'text',
        text: `Run ${value.runId as string} started. Check progress with flow_run_status.`,
      }],
    },
    async execute(args) {
      const runId = await service.runFlow(args.flowId)
      return { runId: runId as unknown as JsonValue }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'flow_run_status',
    description: 'Read one run: its status, the per-node states (with error messages), and the collected result once terminal.',
    parameters: {
      runId: { type: 'string', required: true, description: 'The run id returned by flow_run.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { run: { type: 'json', required: true } } },
      render: (_args, value) => {
        const run = value.run as {
          id: string
          status: string
          nodes: Record<string, { status: string; error?: string }>
          result?: unknown
          error?: string
        }
        const nodeLines = Object.entries(run.nodes)
          .map(([id, state]) => `- ${id}: ${state.status}${state.error !== undefined ? ` — ${state.error}` : ''}`)
          .join('\n')
        const tail = run.error !== undefined ? `\nRun error: ${run.error}` : ''
        const resultTail = run.result !== undefined ? `\nResult: ${JSON.stringify(run.result)}` : ''
        return [{ type: 'text', text: `Run ${run.id} is ${run.status}.\n${nodeLines}${tail}${resultTail}` }]
      },
    },
    execute(args) {
      const run = service.getRun(args.runId)
      if (run === undefined) return Promise.reject(new Error(`run '${args.runId}' is not stored`))
      return Promise.resolve({ run: run as unknown as JsonValue })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'flow_library_search',
    description: 'Search the reusable block library by a case-insensitive substring over name and description (omit the query for everything).',
    parameters: {
      query: { type: 'string', description: 'The filter substring; omit to list the whole library.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { blocks: { type: 'json', required: true } } },
      render: (_args, value) => {
        const blocks = value.blocks as { id: string; name: string; kind: string; description: string }[]
        return [{
          type: 'text',
          text: blocks.length === 0
            ? 'No library blocks matched.'
            : blocks.map(block => `- ${block.name} [${block.kind}] (${block.id}): ${block.description}`).join('\n'),
        }]
      },
    },
    execute(args) {
      return Promise.resolve({ blocks: service.listBlocks(args.query) as unknown as JsonValue })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'flow_block_save',
    description: 'Author or update one reusable library block. A save without id replaces the same-name block, so iterating on a block by name is the expected loop. kind=code blocks must carry their JavaScript in code. Declare typed ports (inputs/outputs: {name, type: any|string|number|json}) and params ({name, type: string|number|boolean|json, required?, default?}).',
    parameters: {
      id: { type: 'string', description: 'Existing block id to update; omit to save by name.' },
      name: { type: 'string', required: true, description: 'Block display name (the save-by-name identity).' },
      kind: { type: 'string', required: true, description: 'How an instance executes: code|llm|agent|shell|http|condition|transform.' },
      description: { type: 'string', required: true, description: 'One-line description surfaced in search results and the palette.' },
      code: { type: 'string', description: 'The block JavaScript (required for kind=code).' },
      inputs: {
        type: 'array',
        description: 'Declared input ports.',
        items: { type: 'object', additionalProperties: true },
      },
      outputs: {
        type: 'array',
        description: 'Declared output ports.',
        items: { type: 'object', additionalProperties: true },
      },
      params: {
        type: 'array',
        description: 'Declared parameters.',
        items: { type: 'object', additionalProperties: true },
      },
      sourceFlowId: { type: 'string', description: 'The workflow the block was extracted from, when it has one.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { block: { type: 'json', required: true } } },
      render: (_args, value) => {
        const block = value.block as { id: string; name: string; kind: string }
        return [{ type: 'text', text: `Block "${block.name}" [${block.kind}] saved to the library (id ${block.id}).` }]
      },
    },
    async execute(args) {
      const block = await service.saveBlock({
        ...args.id !== undefined ? { id: args.id } : {},
        name: args.name,
        kind: args.kind as unknown as BlockSaveRequest['kind'],
        description: args.description,
        ...args.code !== undefined ? { code: args.code } : {},
        inputs: (args.inputs ?? []) as unknown as BlockSaveRequest['inputs'],
        outputs: (args.outputs ?? []) as unknown as BlockSaveRequest['outputs'],
        params: (args.params ?? []) as unknown as BlockSaveRequest['params'],
        ...args.sourceFlowId !== undefined ? { sourceFlowId: args.sourceFlowId } : {},
      })
      return { block: block as unknown as JsonValue }
    },
  }))
}
