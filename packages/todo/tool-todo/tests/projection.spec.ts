/**
 * The `todos` projection provider (session-projection RFC knife 4 — the "a
 * fourth domain is just its own registrations" acceptance probe): mounting
 * tool-todo beside the registry serves the whole current list with a
 * consistent asOfSeq (= last event seq); before any write the value is null; a
 * composition without tool-todo has no `todos` key; unmounting tool-todo
 * removes it (HMR safety). The carrier and framework are exercised unmodified.
 */

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'

interface Bench {
  ctx: Context
  session: Session
  tailProjections(): Promise<{ asOfSeq: number; values: Record<string, unknown> } | undefined>
}

async function harness(withTodoTool: boolean): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  if (withTodoTool) await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
  const session = ctx.sessions.create()
  await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return {
    ctx,
    session,
    async tailProjections() {
      return ctx.sessionProjections.snapshot(session)
    },
  }
}

/** One paginable message so the tail page is non-degenerate. */
function seedMessage(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('todos projection provider', () => {
  it('serves null before the first todo/write', async () => {
    const bench = await harness(true)
    seedMessage(bench.session)
    const projections = await bench.tailProjections()
    expect(projections?.values.todos).toBeNull()
    expect(projections?.asOfSeq).toBe(bench.session.seq - 1)
  })

  it('serves the latest whole list after writes, asOfSeq = last event seq', async () => {
    const bench = await harness(true)
    const session = bench.session
    seedMessage(session)
    const first: TodoItem[] = [{ content: 'a', status: 'pending' }]
    const second: TodoItem[] = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ]
    session.append('turn/start', { turn: 1 })
    session.append('todo/tree-write', { todos: first })
    session.append('todo/tree-write', { todos: second })
    const projections = await bench.tailProjections()
    // Last-wins: the latest snapshot, whole.
    expect(projections?.values.todos).toEqual(second)
    expect(projections?.asOfSeq).toBe(session.seq - 1)
  })

  it('keeps the standing plan across turn/end and the next turn/start', async () => {
    const bench = await harness(true)
    const session = bench.session
    seedMessage(session)
    const list: TodoItem[] = [{ content: 'done', status: 'completed' }]
    session.append('turn/start', { turn: 1 })
    session.append('todo/tree-write', { todos: list })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect((await bench.tailProjections())?.values.todos).toEqual(list)
    session.append('turn/start', { turn: 2 })
    // The tree is a standing plan: only the next todo/write replaces it, so
    // the user keeps seeing the plan while follow-up work runs.
    expect((await bench.tailProjections())?.values.todos).toEqual(list)
  })

  it('clears released flat lists at the next turn and does not promote them to standing plans', async () => {
    const bench = await harness(true)
    bench.session.append('turn/start', { turn: 1 })
    bench.session.append('todo/write', { todos: [{ content: 'legacy task', status: 'pending' }] })
    expect((await bench.tailProjections())?.values.todos).toEqual([{ content: 'legacy task', status: 'pending' }])
    const agent = { session: bench.session }
    const assembly = await bench.ctx.systemPrompt.assemble({ agent, scope: agent } as never)
    expect(assembly.sections.find(section => section.name === 'todo:standing-plan')?.text).toBe('')
    bench.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    bench.session.append('turn/start', { turn: 2 })
    expect((await bench.tailProjections())?.values.todos).toBeNull()
    const tree: TodoItem[] = [{ content: 'standing parent', status: 'pending', children: [{ content: 'retired child', status: 'cancelled' }] }]
    bench.session.append('todo/tree-write', { todos: tree })
    bench.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    bench.session.append('turn/start', { turn: 3 })
    expect((await bench.tailProjections())?.values.todos).toEqual(tree)
    bench.session.append('todo/write', { todos: [{ content: 'later legacy task', status: 'in_progress' }] })
    bench.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    bench.session.append('turn/start', { turn: 4 })
    expect((await bench.tailProjections())?.values.todos).toBeNull()
  })

  it('has no todos key when tool-todo is not composed', async () => {
    const bench = await harness(false)
    seedMessage(bench.session)
    const projections = await bench.tailProjections()
    expect(projections).toBeDefined()
    expect('todos' in (projections?.values ?? {})).toBe(false)
  })

  it('drops the key when the tool-todo fiber unloads (HMR safety)', async () => {
    const bench = await harness(false)
    seedMessage(bench.session)
    const fiber = await bench.ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    expect((await bench.tailProjections())?.values.todos).toBeNull()
    await fiber.dispose()
    expect('todos' in ((await bench.tailProjections())?.values ?? {})).toBe(false)
  })
})

describe('standing-plan prompt section', () => {
  it('renders the latest tree with statuses and the continuation contract', async () => {
    const bench = await harness(true)
    const list: TodoItem[] = [
      { content: 'Phase 1: tiles', status: 'completed', children: [] },
      { content: 'Phase 2: control', status: 'completed', children: [] },
      { content: 'Phase 3: ptys', status: 'pending', children: [] },
    ]
    bench.session.append('todo/tree-write', { todos: list })
    const agent = { session: bench.session }
    const assembly = await bench.ctx.systemPrompt.assemble({ agent, scope: agent } as never)
    const section = assembly.sections.find(candidate => candidate.name === 'todo:standing-plan')
    expect(section).toBeDefined()
    expect(section?.interpolate).toBe(false)
    expect(section?.text).toContain('- [x] Phase 1: tiles')
    expect(section?.text).toContain('- [x] Phase 2: control')
    expect(section?.text).toContain('- [ ] Phase 3: ptys')
    expect(section?.text).toContain('never replace it with a partial tree')
  })

  it('renders nothing before the first write', async () => {
    const bench = await harness(true)
    const agent = { session: bench.session }
    const assembly = await bench.ctx.systemPrompt.assemble({ agent, scope: agent } as never)
    expect(assembly.sections.find(candidate => candidate.name === 'todo:standing-plan')?.text).toBe('')
  })

  it('reflects the latest write after a replacement tree', async () => {
    const bench = await harness(true)
    bench.session.append('todo/tree-write', { todos: [{ content: 'old', status: 'pending', children: [] }] })
    bench.session.append('todo/tree-write', { todos: [{ content: 'new plan', status: 'in_progress', children: [] }] })
    const agent = { session: bench.session }
    const assembly = await bench.ctx.systemPrompt.assemble({ agent, scope: agent } as never)
    const text = assembly.sections.find(candidate => candidate.name === 'todo:standing-plan')?.text ?? ''
    expect(text).toContain('- [~] new plan')
    expect(text).not.toContain('old')
  })

  it('keeps template-looking todo content literal', async () => {
    const bench = await harness(true)
    bench.session.append('todo/tree-write', { todos: [{ content: 'Preserve {{source}}', status: 'pending', children: [] }] })
    const agent = { session: bench.session }
    const assembly = await bench.ctx.systemPrompt.assemble({ agent, scope: agent } as never)
    expect(renderPrompt(assembly)).toContain('Preserve {{source}}')
  })
})
