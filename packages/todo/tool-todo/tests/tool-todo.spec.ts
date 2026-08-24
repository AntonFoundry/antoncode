import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import { type Agent } from '@deepseek-ai/dsh-agent'

import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/**
 * Drives the REAL plugin body: mounts `dsh-tool-todo` on a real `ToolRuntime`
 * and invokes the registered `todo_write` tool through `ctx.tools.execute`,
 * with a fake parent Agent carrying a real `Session` — so the append the tool
 * makes is observable on a genuine session log (only the agent wrapper is a
 * stand-in; the session and the tool are the shipping code).
 */

/** A parent Agent backed by a real Session — the tool reads `agent.session`. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(allowParallelInProgress: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, { allowParallelInProgress })
  return ctx
}

let callCounter = 0
function callTodo(ctx: Context, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'todo_write',
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-tool-todo', () => {
  it('registers a `todo_write` tool whose schema is an array of {content,status}', async () => {
    const ctx = await setup(true)
    const schema = ctx.tools.schemas().find(s => s.name === 'todo_write')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toEqual(['todos'])
    const todos = props.todos as {
      type: string
      items?: {
        properties?: Record<string, { type: string; enum?: string[] }>
      }
    }
    expect(todos.type).toBe('array')
    const itemProps = todos.items?.properties ?? {}
    // A top-level node: content, the four-state status, optional priority, optional children.
    expect(Object.keys(itemProps).sort()).toEqual(['children', 'content', 'priority', 'status'])
    expect(itemProps.status?.enum).toEqual(['pending', 'in_progress', 'completed', 'cancelled'])

    // Level two carries the same fields plus its own children (level three).
    const childItems = itemProps.children as {
      items?: { properties?: Record<string, unknown> }
    }
    const childProps = childItems.items?.properties ?? {}
    expect(Object.keys(childProps).sort()).toEqual(['children', 'content', 'priority', 'status'])

    // Level three is leaf-shaped: no further nesting can be expressed.
    const grandItems = childProps.children as {
      items?: { properties?: Record<string, unknown> }
    }
    const grandProps = grandItems.items?.properties ?? {}
    expect(Object.keys(grandProps).sort()).toEqual(['content', 'priority', 'status'])
  })

  it('appends a todo/write event carrying the whole list to the calling session', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('writer')
    const todos: TodoItem[] = [
      { content: 'plan', status: 'in_progress' },
      { content: 'build', status: 'pending' },
    ]
    const result = await callTodo(ctx, { todos }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected todo_write success')
    expect(result.value).toEqual({
      todos,
      counts: { pending: 1, inProgress: 1, completed: 0, cancelled: 0 },
    })
    expect(text(result)).toContain('1 pending, 1 in progress, 0 completed, 0 cancelled')

    const event = agent.session.events.findLast(e => e.type === 'todo/write')!
    expect(event.data.todos).toEqual(todos)
  })

  it('stores the trimmed content (the dedupe/length key), not the raw input', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('trim')
    const result = await callTodo(ctx, { todos: [{ content: '  plan the work  ', status: 'pending' }] }, { agent })
    expect(result.isError).toBe(false)

    const event = agent.session.events.findLast(e => e.type === 'todo/write')!
    expect(event.data.todos).toEqual([{ content: 'plan the work', status: 'pending' }])
  })

  it('replaces the list on a second call (last-write-wins on the log)', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('writer-2')
    await callTodo(ctx, { todos: [{ content: 'a', status: 'pending' }] }, { agent })
    await callTodo(ctx, { todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ] }, { agent })

    const current = agent.session.events.findLast(e => e.type === 'todo/write')!.data.todos
    expect(current).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ])
  })

  it('stores a nested three-level tree and counts across every level', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('tree')
    const todos: TodoItem[] = [
      {
        content: 'ship feature',
        status: 'in_progress',
        priority: 'high',
        children: [
          {
            content: 'implement',
            status: 'completed',
            children: [{ content: 'core logic', status: 'completed' }],
          },
          { content: 'test', status: 'pending', priority: 'medium' },
          { content: 'old approach', status: 'cancelled' },
        ],
      },
    ]
    const result = await callTodo(ctx, { todos }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected todo_write success')
    // Counts span the whole tree: 2 completed (one is a grandchild), 1 pending,
    // 1 active top-level node, 1 cancelled.
    expect(result.value).toEqual({
      todos,
      counts: { pending: 1, inProgress: 1, completed: 2, cancelled: 1 },
    })
    expect(text(result)).toContain('1 pending, 1 in progress, 2 completed, 1 cancelled')

    const event = agent.session.events.findLast(e => e.type === 'todo/write')!
    expect(event.data.todos).toEqual(todos)
  })

  it('counts an in_progress child toward the whole-tree single-active rule', async () => {
    const ctx = await setup(false)
    const agent = agentWithSession('nested-active')
    const result = await callTodo(ctx, { todos: [{
      content: 'parent',
      status: 'in_progress',
      children: [{ content: 'child', status: 'in_progress' }],
    }] }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('at most one task may be in_progress across the whole tree')
    expect(agent.session.events.some(e => e.type === 'todo/write')).toBe(false)
  })

  it('rejects duplicate content across different levels', async () => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { todos: [{
      content: 'dup',
      status: 'pending',
      children: [{ content: 'dup', status: 'pending' }],
    }] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('duplicate')
  })

  it('rejects a malformed status before execute runs (registry arg-validation)', async () => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { todos: [{ content: 'x', status: 'doing' }] })
    expect(result.isError).toBe(true)
  })

  it('rejects a non-array todos argument', async () => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { todos: 'nope' })
    expect(result.isError).toBe(true)
  })

  it('accepts several in_progress items at once (parallel work)', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('parallel')
    const todos: TodoItem[] = [
      { content: 'run subagent a', status: 'in_progress' },
      { content: 'run subagent b', status: 'in_progress' },
      { content: 'merge results', status: 'pending' },
    ]
    const result = await callTodo(ctx, { todos }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected todo_write success')
    expect(result.value).toEqual({
      todos,
      counts: { pending: 1, inProgress: 2, completed: 0, cancelled: 0 },
    })
    expect(agent.session.events.findLast(e => e.type === 'todo/write')!.data.todos).toEqual(todos)
  })

  describe('allowParallelInProgress', () => {
    const parallel = [
      { content: 'run subagent a', status: 'in_progress' },
      { content: 'run subagent b', status: 'in_progress' },
    ]

    it('false rejects a call marking several items in_progress', async () => {
      const ctx = await setup(false)
      const agent = agentWithSession('single-active')
      const result = await callTodo(ctx, { todos: parallel }, { agent })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('at most one task may be in_progress')
      // A rejected call must not reach the durable log.
      expect(agent.session.events.some(e => e.type === 'todo/write')).toBe(false)
    })

    it('false still accepts one active item', async () => {
      const ctx = await setup(false)
      const todos: TodoItem[] = [
        { content: 'run subagent a', status: 'in_progress' },
        { content: 'run subagent b', status: 'pending' },
      ]
      const result = await callTodo(ctx, { todos })
      expect(result.isError).toBe(false)
    })

    it('true accepts the very list false rejects', async () => {
      const ctx = await setup(true)
      const result = await callTodo(ctx, { todos: parallel })
      expect(result.isError).toBe(false)
    })

    it('instructs the model to keep at most one active, while true instructs parallel', async () => {
      const single = await setup(false)
      const singleDesc = single.tools.schemas().find(s => s.name === 'todo_write')!.description
      expect(singleDesc).toContain('Keep AT MOST ONE node `in_progress`')
      expect(singleDesc).not.toContain('several at once')

      const parallelDesc = (await setup(true)).tools.schemas().find(s => s.name === 'todo_write')!.description
      expect(parallelDesc).toContain('several at once when work genuinely runs concurrently')
      expect(parallelDesc).not.toContain('AT MOST ONE')
    })
  })

  it.each([
    { label: 'empty content', todos: [{ content: '   ', status: 'pending' }], fragment: 'non-empty' },
    { label: 'duplicate content', todos: [{ content: 'dup', status: 'pending' }, { content: 'dup', status: 'completed' }], fragment: 'duplicate' },
    { label: 'a fourth level of nesting', todos: [{ content: 'a', status: 'pending', children: [{ content: 'b', status: 'pending', children: [{ content: 'c', status: 'pending', children: [{ content: 'd', status: 'pending' }] }] }] }], fragment: 'not a declared property' },
    { label: 'an unknown priority', todos: [{ content: 'a', status: 'pending', priority: 'urgent' }], fragment: 'must be one of' },
  ])('rejects $label as an isError result', async ({ todos, fragment }) => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { todos })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(fragment)
  })

  it('rejects a non-agent caller (the list has no owning session)', async () => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { todos: [{ content: 'a', status: 'pending' }] }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owning agent session')
  })

  it('presents the call with a stable title and the tree as raw input', async () => {
    const ctx = await setup(true)
    const def = ctx.tools.get('todo_write')!
    const todos = [{ content: 'a', status: 'pending' }]
    expect(def.presentCall?.({ todos })).toEqual({ card: 'generic', title: 'Update todo tree', kind: 'other', rawInput: todos })
  })

  it('unregisters the tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(tool, { allowParallelInProgress: true })
    expect(ctx.tools.schemas().some(s => s.name === 'todo_write')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'todo_write')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // A default export would make Loader unwrap only apply and drop `inject`.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-todo')
    expect(tool.inject).toEqual(['tools'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-todo')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
