/**
 * Model-facing whole-tree replacement. Each call appends a `todo/write` snapshot to the calling
 * agent's session; replay is last-write-wins, and UIs render from session events. A non-agent
 * caller has no owning list and is rejected. Named exports preserve loader injection metadata.
 *
 * The list is a TREE of up to three levels (top-level task, child, grandchild) — the port of
 * OpenCode's todo tree (`Todo.Info`): every node carries `content`/`status` plus an optional
 * `priority`, and a node may nest `children` instead of exploding one phase into many siblings.
 * Every agent session owns its own tree, so an orchestrator keeps the top-level nodes while a
 * subagent delegated to one node maintains its own subtree in its own session.
 *
 * @module @deepseek-ai/dsh-tool-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { TodoItem } from './types.ts'
// Type-only: resolves the required ctx.sessionProjections service declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
// The `todos` projection-key declaration lives in src/types.ts (its one home);
// this re-export projects the type face onto the package root AND keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'

export const name = 'tool-todo'
export const inject = ['tools', 'sessionProjections']

/** The valid {@link TodoItem} statuses, as a runtime set for input narrowing. */
const STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const
/** The valid {@link TodoItem} priorities, as a runtime set. */
const PRIORITIES = ['high', 'medium', 'low'] as const

/** Model-facing todo tool configuration. */
export interface Config {
  /**
   * Required deployment choice for whether several todos may be `in_progress` at once. True suits
   * agents that run work concurrently — subagents, background commands, workflow fan-out — and the
   * description then instructs the model to mark every actively worked task. False restores the
   * single-active discipline: the description asks for exactly one, and a call marking more is
   * rejected. The count spans the whole tree.
   */
  allowParallelInProgress: boolean
}

/** Schemastery configuration for the todo tool consumer. */
export const Config: z<Config> = z.object({
  allowParallelInProgress: z.boolean().required(),
})

/**
 * The model-facing description's shared body. Ported from OpenCode's todowrite prompt
 * (`todowrite.txt`): plan first, write the tree, execute sequentially — with the nesting,
 * delegation, and lifecycle discipline spelled out where the model reads it. The plan is
 * recorded with plan_write before the tree for non-trivial work, matching the todo-plan
 * gate's threshold so a large tree never blocks execution tools mid-flight.
 */
const DESCRIPTION_HEAD =
  'Create and manage a structured task tree for the current work. Send the ENTIRE '
  + 'tree every call — it REPLACES the previous tree (there are no partial updates, no per-node '
  + 'edits). Use it to plan multi-step work and show progress. Using this tool is the DEFAULT, '
  + 'not an opt-in: before executing any work with more than one step, plan first — recording '
  + 'the plan with plan_write first when the work is non-trivial (3 or more tasks, multi-phase, '
  + 'cross-package, or architectural) — then write the tree and execute against it; do not wait '
  + 'for the user to ask for a plan.'

const DESCRIPTION_WORKFLOW = `
Workflow: plan first, then encode the plan as a todo tree, then execute it one node at a time:
1. Plan: analyze the request and form a step-by-step plan before taking any action. For
   non-trivial work (3 or more tasks, multi-phase, cross-package, or architectural), record
   the plan with plan_write BEFORE calling this tool; if a delegating subagent fails or is
   unavailable, author the plan from current knowledge and proceed inline — never stall on
   a failed delegation.
2. Write the tree: convert the plan into this tool's \`todos\` argument. Nest child tasks under a
   parent when they are its concrete phases or subtasks — up to three levels (task, child,
   grandchild); never deeper, and keep simple work flat rather than nesting for its own sake.
3. Execute sequentially: keep exactly one branch of work \`in_progress\`, finish it, mark it
   \`completed\`, and move to the next. Update statuses in real time — mark a node completed the
   moment it is done, never batch completions.

Persistence: the tree OUTLIVES the turn — the user sees it between and across messages, so it
is the standing plan, not a per-turn scratchpad. At the start of any new user request that
involves multi-step work, plan first (plan_write for non-trivial work), then write the tree
(rewriting or extending the standing one) before any other tool call. When later phases or
follow-ups remain, leave them \`pending\` on the tree rather than reporting everything
completed; an all-settled tree is only correct when the whole request is genuinely finished.`

const DESCRIPTION_DELEGATION =
  '\nDelegation: every agent session owns its own tree. As the orchestrator, keep the top-level '
  + 'nodes here; when you delegate one node to a subagent, that node stays on your tree until its '
  + 'subtree reports back, and the subagent tracks its own finer-grained subtree in its own session '
  + 'rather than rewriting yours.'

const DESCRIPTION_LIFECYCLE =
  '\nNode fields: \`status\` is pending (not started) | in_progress (being worked on now) | '
  + 'completed (done) | cancelled (no longer needed); \`priority\` optionally ranks nodes '
  + '(high | medium | low). Mark a parent completed only after all of its children are completed '
  + 'or cancelled. Only a trivial single-step request (one obvious action, no phases) may skip '
  + 'the tree; when in doubt, write it.'

const DESCRIPTION_PARALLEL =
  '\nParallelism: mark every node being actively worked `in_progress` — several at once when work '
  + 'genuinely runs concurrently (e.g. parallel subagents or background commands); while work '
  + 'remains, at least one task should be `in_progress`.'

const DESCRIPTION_SINGLE =
  '\nParallelism: Keep AT MOST ONE node `in_progress` at a time across the whole tree; while work '
  + 'remains, exactly one active task should be `in_progress`.'

/**
 * The model-facing description for one activation. The active-status clause is the only part that
 * varies, because it is the only instruction the parallel policy changes.
 * @param allowParallel - whether several todos may be `in_progress` at once.
 * @returns the composed tool description.
 */
function describe(allowParallel: boolean): string {
  const parallelism = allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE
  return DESCRIPTION_HEAD + DESCRIPTION_WORKFLOW + DESCRIPTION_DELEGATION + DESCRIPTION_LIFECYCLE + parallelism
}

/** One model-supplied node, already schema-checked but not yet normalized. */
interface RawTodoNode {
  content: string
  status: string
  priority?: string
  children?: RawTodoNode[]
}

/**
 * Validate and normalize one node and its subtree: trimmed non-empty content unique across the
 * whole tree, a known status, an optional known priority, and the depth cap the JSON schema also
 * enforces (a fourth level cannot even be expressed, because grandchild shapes carry no
 * `children` property and `additionalProperties: false` rejects it).
 * @param raw - the model-supplied node, already schema-checked.
 * @param depth - 1-based level of this node in the tree.
 * @param seen - content strings already used anywhere in the tree.
 * @param allowParallel - whether several nodes may be `in_progress` at once.
 * @param active - running count of `in_progress` nodes across the tree.
 * @returns the canonical node.
 */
function toTodoNode(raw: RawTodoNode, depth: number, seen: Set<string>, allowParallel: boolean, state: { active: number }): TodoItem {
  if (depth > 3) throw new Error('invalid todos: trees nest at most three levels deep')
  const content = raw.content.trim()
  if (content.length === 0) {
    throw new Error('invalid todos: `content` must be a non-empty string')
  }
  if (seen.has(content)) {
    throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`)
  }
  seen.add(content)
  if (!(STATUSES as readonly string[]).includes(raw.status)) {
    throw new Error(`invalid todos: unknown status ${JSON.stringify(raw.status)}`)
  }
  if (raw.status === 'in_progress') state.active++
  if (raw.priority !== undefined && !(PRIORITIES as readonly string[]).includes(raw.priority)) {
    throw new Error(`invalid todos: unknown priority ${JSON.stringify(raw.priority)}`)
  }
  const children = raw.children?.map(child => toTodoNode(child, depth + 1, seen, allowParallel, state))
  return {
    content,
    status: raw.status as TodoItem['status'],
    ...raw.priority === undefined ? {} : { priority: raw.priority as NonNullable<TodoItem['priority']> },
    ...children === undefined ? {} : { children },
  }
}

/**
 * Validate the value constraints the ParameterSchemaSpec can't express and build the canonical
 * {@link TodoItem} tree: trimmed non-empty unique content across all levels, known statuses and
 * priorities, and at most one `in_progress` node in the whole tree unless the deployment allows
 * parallel work. The handler repairs corrupted entries first (`repairTodoTree`); this walk owns
 * the cross-node values on the repaired tree.
 * @param raw - the model-supplied tree, already schema-checked.
 * @param allowParallel - whether several nodes may be `in_progress` at once.
 * @returns the canonical tree.
 */
function toTodoTree(raw: RawTodoNode[], allowParallel: boolean): TodoItem[] {
  const seen = new Set<string>()
  const state = { active: 0 }
  const tree = raw.map(node => toTodoNode(node, 1, seen, allowParallel, state))
  if (!allowParallel && state.active > 1) {
    throw new Error(`invalid todos: at most one task may be in_progress across the whole tree (got ${state.active})`)
  }
  return tree
}

/** Every node of the tree in depth-first order — counts and search index over one walk. */
function flat(todos: readonly TodoItem[]): readonly TodoItem[] {
  return todos.flatMap(todo => [todo, ...flat(todo.children ?? [])])
}

/** Status glyphs for the standing-plan section, checklist style. */
const SECTION_GLYPH: Record<TodoItem['status'], string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
  cancelled: '[-]',
}

/**
 * Render the standing plan as the model-facing section body: the whole tree
 * as a checklist plus the continuation contract (extend, never partially
 * replace). Exported for the section spec.
 * @param todos - the latest todo/write tree.
 * @returns the section text.
 */
export function standingPlanSection(todos: readonly TodoItem[]): string {
  const lines: string[] = []
  const walk = (nodes: readonly TodoItem[], depth: number): void => {
    for (const node of nodes) {
      lines.push(`${'  '.repeat(depth)}- ${SECTION_GLYPH[node.status]} ${node.content}`)
      if (node.children?.length) walk(node.children, depth + 1)
    }
  }
  walk(todos, 0)
  return [
    'Standing todo plan (the todo_write tree currently in force — it persists across turns):',
    ...lines,
    'When the user asks to continue this plan: keep finished nodes completed, mark the next work in_progress, and extend the tree with todo_write — never replace it with a partial tree. Only a whole new plan replaces it, via one todo_write carrying the complete new tree.',
  ].join('\n')
}

/** Wire payload schema of the `todos` projection (whole tree or pre-first-write null). */
// zod models `.optional()` outputs as `T | undefined` properties, which
// exactOptionalPropertyTypes cannot relate to TodoItem's absent-key optionals;
// the runtime objects zod produces satisfy TodoItem exactly, so the contract
// lives in the annotation and the initializer casts.
const todoNodeSchema = zod.lazy(() => zod.object({
  content: zod.string(),
  status: zod.union([
    zod.literal('pending'),
    zod.literal('in_progress'),
    zod.literal('completed'),
    zod.literal('cancelled'),
  ]),
  priority: zod.union([zod.literal('high'), zod.literal('medium'), zod.literal('low')]).optional(),
  children: zod.array(zod.lazy(() => todoNodeSchema)).optional(),
})) as unknown as ZodType<TodoItem>

const todosProjectionSchema = zod.union([
  zod.array(todoNodeSchema),
  zod.null(),
]) as ZodType<TodoItem[] | null>

/** The JSON-schema object shape of a grandchild (leaf): no `children`, so depth ends here. */
function leafSchemaShape(): ObjectValueSchemaSpec {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      content: { type: 'string', description: 'What the task is — a short imperative line.' },
      status: {
        type: 'string',
        enum: [...STATUSES],
        description: 'pending (not started) | in_progress (now) | completed (done) | cancelled (dropped).',
      },
      priority: {
        type: 'string',
        enum: [...PRIORITIES],
        description: 'Optional scheduling weight: high | medium | low.',
      },
    },
  }
}

/**
 * Salvage one model-supplied node before strict normalization: model output occasionally arrives
 * corrupted (junk entries like `{"content ": ", "}` or `{"": null}`, string children, missing
 * statuses). This pass trims object keys, coerces a string entry to a pending node, drops entries
 * with no usable `content`, defaults missing/unknown statuses to `pending`, omits invalid
 * priorities, and caps nesting at three levels by ignoring deeper `children`. Unknown keys are
 * ignored. Entry is `null` when nothing survives.
 * @param raw - one unvalidated array entry.
 * @param depth - 1-based level this entry would occupy.
 * @returns the repaired node, or null to drop the entry.
 */
function repairTodoNode(raw: unknown, depth: number): RawTodoNode | null {
  if (typeof raw === 'string') {
    const content = raw.trim()
    return content.length > 0 ? { content, status: 'pending' } : null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) record[key.trim()] = value
  const content = typeof record.content === 'string' ? record.content.trim() : ''
  if (content.length === 0) return null
  const node: RawTodoNode = {
    content,
    status: (STATUSES as readonly string[]).includes(record.status as string)
      ? record.status as string
      : 'pending',
  }
  if ((PRIORITIES as readonly string[]).includes(record.priority as string)) {
    node.priority = record.priority as string
  }
  if (Array.isArray(record.children) && depth < 3) {
    const children = record.children
      .map(child => repairTodoNode(child, depth + 1))
      .filter((child): child is RawTodoNode => child !== null)
    if (children.length > 0) node.children = children
  }
  return node
}

/**
 * Salvage the whole `todos` payload: repair each entry and drop the unsalvageable, so a few
 * corrupted entries never lose the whole tree. An empty input array stays an (allowed) empty
 * tree; a non-empty input whose entries all fail salvage rejects loudly instead of silently
 * wiping the standing plan.
 * @param raw - the model-supplied `todos` value.
 * @returns repaired nodes for {@link toTodoTree}.
 */
function repairTodoTree(raw: unknown): RawTodoNode[] {
  if (!Array.isArray(raw)) throw new Error('invalid todos: `todos` must be an array')
  if (raw.length === 0) return []
  const nodes = raw.map(node => repairTodoNode(node, 1)).filter((node): node is RawTodoNode => node !== null)
  if (nodes.length === 0) {
    throw new Error('invalid todos: no salvageable entries — every node was malformed')
  }
  return nodes
}

/**
 * Register the `todo_write` tool on `ctx.tools` and the `todos` unit on
 * `ctx.sessionProjections`.
 * @param ctx - registrant context carrying the tool and session-projection registries.
 * @param config - deployment's explicit todo policy.
 * @returns when the plugin is ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const allowParallel = config.allowParallelInProgress
  // Standing-plan fold: the latest whole todo/write tree persists across
  // turns — a plan the user can still see while follow-up work runs, not a
  // per-turn scratchpad a new turn/start wipes. Only the next todo/write
  // replaces it; null before the first write; every other event returns the
  // same state reference.
  const todosProjection = await ctx.sessionProjections.register<'todos', TodoItem[] | null>({
    key: 'todos',
    stateSchema: todosProjectionSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'todo/write') return event.data.todos
      return state
    },
    wire: { viewSchema: todosProjectionSchema, view: state => state, summary: false },
    stateVersion: 4,
  })
  // Standing-plan section: the latest todo/write tree rides every model
  // request, so "continue" extends the real plan instead of replacing it
  // with whatever survived compaction. It reads the `todos` projection state.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'todo:standing-plan',
      // Between plan policy and the plan package's standing plan (policy + 2).
      order: promptCtx.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
      interpolate: false,
      text: (context) => {
        if (context.agent === undefined) return ''
        const todos = todosProjection.stateOf(context.agent.session)
        return todos === null ? '' : standingPlanSection(todos)
      },
    })
  })
  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: describe(allowParallel),
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task tree, replacing any previous tree. Up to three levels: a top-level task nests children, which may themselves nest grandchildren.',
        // Tolerant: corrupted entries (junk keys, missing fields, string
        // children) pass the schema boundary so the handler's repair pass can
        // salvage them instead of losing the whole call to `invalid arguments`.
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: true,
              properties: {
                content: { type: 'string', description: 'What the task is — a short imperative line.' },
                status: {
                  type: 'string',
                  enum: [...STATUSES],
                  description: 'pending (not started) | in_progress (now) | completed (done) | cancelled (dropped).',
                },
                priority: {
                  type: 'string',
                  enum: [...PRIORITIES],
                  description: 'Optional scheduling weight: high | medium | low.',
                },
                children: {
                  type: 'array',
                  description: 'Subtasks of this node (level two). Each child may itself nest grandchildren (level three); nothing nests below that.',
                  items: {
                    oneOf: [
                      {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                          content: { type: 'string', description: 'What the task is — a short imperative line.' },
                          status: {
                            type: 'string',
                            enum: [...STATUSES],
                            description: 'pending (not started) | in_progress (now) | completed (done) | cancelled (dropped).',
                          },
                          priority: {
                            type: 'string',
                            enum: [...PRIORITIES],
                            description: 'Optional scheduling weight: high | medium | low.',
                          },
                          children: {
                            type: 'array',
                            description: 'Grandchildren of this node (level three — the deepest). Leaf shapes: no further nesting.',
                            items: {
                              oneOf: [
                                leafSchemaShape(),
                                { type: 'string', description: 'A bare task line; repaired into a pending node.' },
                              ],
                            },
                          },
                        },
                      },
                      { type: 'string', description: 'A bare task line; repaired into a pending node.' },
                    ],
                  },
                },
              },
            },
            { type: 'string', description: 'A bare task line; repaired into a pending node.' },
          ],
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: [...STATUSES] },
                priority: { type: 'string', enum: [...PRIORITIES] },
                children: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      content: { type: 'string', required: true },
                      status: { type: 'string', required: true, enum: [...STATUSES] },
                      priority: { type: 'string', enum: [...PRIORITIES] },
                      children: {
                        type: 'array',
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          properties: {
                            content: { type: 'string', required: true },
                            status: { type: 'string', required: true, enum: [...STATUSES] },
                            priority: { type: 'string', enum: [...PRIORITIES] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              pending: { type: 'integer', required: true },
              inProgress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
              cancelled: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated todo tree: ${value.counts.pending} pending, ${value.counts.inProgress} in progress,`
          + ` ${value.counts.completed} completed, ${value.counts.cancelled} cancelled.`,
      }],
    },
    execute(args, exec) {
      const todos = toTodoTree(repairTodoTree(args.todos), allowParallel)
      if (!exec.agent) {
        // The tree is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('todo_write requires an owning agent session')
      }
      exec.agent.session.append('todo/write', { todos })
      const count = (status: TodoItem['status']): number => flat(todos).filter(t => t.status === status).length
      return Promise.resolve({
        todos,
        counts: {
          pending: count('pending'),
          inProgress: count('in_progress'),
          completed: count('completed'),
          cancelled: count('cancelled'),
        },
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo tree', kind: 'other', rawInput: args.todos }),
  }))
}
