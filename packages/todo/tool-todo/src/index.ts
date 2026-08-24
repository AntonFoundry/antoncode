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
import type { TodoItem } from '@deepseek-ai/dsh-session'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
// The `todos` projection-key declaration lives in src/types.ts (its one home);
// this re-export projects the type face onto the package root AND keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'

export const name = 'tool-todo'
export const inject = ['tools']

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
 * delegation, and lifecycle discipline spelled out where the model reads it.
 */
const DESCRIPTION_HEAD =
  'Create and manage a structured task tree for the current work. Send the ENTIRE '
  + 'tree every call — it REPLACES the previous tree (there are no partial updates, no per-node '
  + 'edits). Use it to plan multi-step work and show progress.'

const DESCRIPTION_WORKFLOW = `
Workflow: plan first, then encode the plan as a todo tree, then execute it one node at a time:
1. Plan: analyze the request and form a step-by-step plan before taking any action.
2. Write the tree: convert the plan into this tool's \`todos\` argument. Nest child tasks under a
   parent when they are its concrete phases or subtasks — up to three levels (task, child,
   grandchild); never deeper, and keep simple work flat rather than nesting for its own sake.
3. Execute sequentially: keep exactly one branch of work \`in_progress\`, finish it, mark it
   \`completed\`, and move to the next. Update statuses in real time — mark a node completed the
   moment it is done, never batch completions.`

const DESCRIPTION_DELEGATION =
  '\nDelegation: every agent session owns its own tree. As the orchestrator, keep the top-level '
  + 'nodes here; when you delegate one node to a subagent, that node stays on your tree until its '
  + 'subtree reports back, and the subagent tracks its own finer-grained subtree in its own session '
  + 'rather than rewriting yours.'

const DESCRIPTION_LIFECYCLE =
  '\nNode fields: \`status\` is pending (not started) | in_progress (being worked on now) | '
  + 'completed (done) | cancelled (no longer needed); \`priority\` optionally ranks nodes '
  + '(high | medium | low). Mark a parent completed only after all of its children are completed '
  + 'or cancelled. Skip the tree entirely for trivial single-step tasks.'

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
 * parallel work. The registry has already enforced the structural rules (node object shape, enum
 * membership, depth via the leaf shapes' missing `children`, `additionalProperties: false`), so a
 * malformed tree fails loud at the schema boundary; this walk owns only the cross-node values.
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
    additionalProperties: false,
    properties: {
      content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
      status: {
        type: 'string',
        required: true,
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
 * Register the `todo_write` tool on `ctx.tools` and, when the session-projection seam is composed,
 * the `todos` unit.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit todo policy.
 */
export function apply(ctx: Context, config: Config): void {
  const allowParallel = config.allowParallelInProgress
  // The unit child activates only when a projection registry is composed
  // (headless assemblies without the seam stay unaffected). Standing-plan fold:
  // latest whole todo/write tree, cleared by the next turn/start (turn/end keeps
  // the finished checklist visible); null before the first write or after a
  // later turn begins; every other event returns the same state reference.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'todos', TodoItem[] | null>({
      key: 'todos',
      schema: todosProjectionSchema,
      init: () => null,
      apply: (state, event) => {
        if (event.type === 'todo/write') return event.data.todos
        if (event.type === 'turn/start') return null
        return state
      },
      view: state => state,
      stateVersion: 3,
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
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
            status: {
              type: 'string',
              required: true,
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
              description: 'Subtasks of this node (level two). Each child may itself carry grandchildren (level three); nothing nests below that.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
                  status: {
                    type: 'string',
                    required: true,
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
                    items: leafSchemaShape(),
                  },
                },
              },
            },
          },
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
      const todos = toTodoTree(args.todos as unknown as RawTodoNode[], allowParallel)
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
