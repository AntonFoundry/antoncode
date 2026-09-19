// @vitest-environment jsdom
// The todo-plan gate: with the gate enabled, gated tools are denied until the
// session log carries a todo/write plan (the denial teaches the fix);
// todo_write itself is never gated and a landed plan re-opens the tools; a
// session-log read failure fails open. Driven through the same real agent
// loop as gate-policy.spec.ts; the todo_write stub mirrors the real tool's
// session append.

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MockAdapter, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as GatePolicy from '@deepseek-ai/dsh-gate-policy'
import type { Config } from '@deepseek-ai/dsh-gate-policy'

const GATED: Config = {
  todoPlanGate: { enabled: true, tools: ['bash'] },
  rules: [],
}

async function harness(config: Config, adapter: MockAdapter): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(GatePolicy, config)
  // The bash tool: the gated call.
  ctx.tools.register(defineContentToolFixture({ name: 'bash', description: 'b', parameters: {}, async execute() { return [{ type: 'text', text: 'ran' }] } }))
  // The todo_write tool: appends the plan to the session log, exactly what
  // the real tool does (the registry-facing shape is a stub).
  ctx.tools.register(defineContentToolFixture({
    name: 'todo_write',
    description: 't',
    parameters: {},
    async execute(args, exec) {
      const todos = (args as { todos?: unknown })?.todos ?? [{ content: 'plan', status: 'in_progress' }]
      exec.agent!.session.append('todo/write', { todos: todos as unknown as never })
      return [{ type: 'text', text: 'planned' }]
    },
  }))
  // The plan_write tool: appends the implementation plan to the session log.
  ctx.tools.register(defineContentToolFixture({
    name: 'plan_write',
    description: 'p',
    parameters: {},
    async execute(args, exec) {
      const plan = (args as { plan?: string })?.plan ?? '# Implementation Plan\n\nDetails'
      exec.agent!.session.append('plan/write', { plan, title: 'Implementation Plan', path: 'implementation_plan.md' })
      return [{ type: 'text', text: 'plan recorded' }]
    },
  }))
  // The subagent tool: stub subagent delegation.
  ctx.tools.register(defineContentToolFixture({
    name: 'subagent',
    description: 's',
    parameters: {},
    async execute() {
      return [{ type: 'text', text: 'subagent finished' }]
    },
  }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('plan-gate-test'), { provider: 'mock', model: 'mock' })
  return { ctx, agent }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

function run(ctx: Context, agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  return waitForIdle(ctx, agent)
}

function toolResults(agent: Agent): { text: string; isError: boolean }[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
    .map((e) => {
      const first = e.data.message.content[0]
      return {
        text: first.content.map(block => block.type === 'text' ? block.text : '').join(''),
        isError: first.isError ?? false,
      }
    })
}

describe('todo-plan gate', () => {
  it('denies bash before any plan, teaching the todo_write fix', async () => {
    const { ctx, agent } = await harness(GATED, new MockAdapter([toolCallResponse('c1', 'bash', { command: 'echo hi' })]))
    await run(ctx, agent)
    const results = toolResults(agent)!
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(true)
    expect(results[0]!.text).toContain("Gate 'todo-plan' blocked this call")
    expect(results[0]!.text).toContain('Call todo_write')
    expect(results[0]!.text).toContain('retry `bash`')
  })

  it('never gates todo_write itself: writing the plan then bash runs', async () => {
    const { ctx, agent } = await harness(GATED, new MockAdapter([
      toolCallResponse('c1', 'todo_write', { todos: [{ content: 'plan', status: 'in_progress' }] }),
      toolCallResponse('c2', 'bash', { command: 'echo hi' }),
    ]))
    await run(ctx, agent)
    const results = toolResults(agent)!
    expect(results).toHaveLength(2)
    expect(results[0]!.text).toBe('planned')
    expect(results[1]!.isError).toBe(false)
    expect(results[1]!.text).toBe('ran')
  })

  it('fails open when the session log is unreadable', async () => {
    const { ctx, agent } = await harness(GATED, new MockAdapter([]))
    // The registered guards are reachable through the scoped registry; drive
    // the plugin's guard with a fake agent whose session cannot serve the
    // log, and assert the gated call is allowed (fail open) — the guard's
    // contract, independent of the dispatch machinery around it.
    // The guard's own dispatch walks layers.chainLayers(exec.agent); this
    // probe drives the global layer's first guard, which is the plugin's.
    type Guard = (request: {
      name: string
      arguments: Record<string, unknown>
      agent: unknown
    }) => Promise<undefined | { message: string }>
    const layers = (ctx.tools as unknown as {
      layers: {
        global: { guards: { values(): IterableIterator<Guard> } }
        chainLayers(scope: unknown): Array<{ guards: { values(): IterableIterator<Guard> } }>
      }
    }).layers
    const all = [
      ...layers.global.guards.values(),
      ...layers.chainLayers({}).flatMap(layer => [...layer.guards.values()]),
    ]
    expect(all.length).toBeGreaterThan(0)
    const guard = all[all.length - 1]
    expect(typeof guard).toBe('function')
    const denial = await guard!({ name: 'bash', arguments: { command: 'echo hi' }, agent: { id: agent.id, session: {} } })
    expect(denial).toBeUndefined()
  })

  it('allows mutation tools without plan_write when todo count is below threshold (< 3)', async () => {
    const { ctx, agent } = await harness(GATED, new MockAdapter([
      toolCallResponse('c1', 'todo_write', {
        todos: [
          { content: 'task 1', status: 'in_progress' },
          { content: 'task 2', status: 'pending' },
        ],
      }),
      toolCallResponse('c2', 'bash', { command: 'echo ok' }),
    ]))
    await run(ctx, agent)
    const results = toolResults(agent)!
    expect(results).toHaveLength(2)
    expect(results[0]!.text).toBe('planned')
    expect(results[1]!.isError).toBe(false)
    expect(results[1]!.text).toBe('ran')
  })

  it('denies mutation tools when todo count is >= 3 and no implementation plan exists', async () => {
    const { ctx, agent } = await harness(GATED, new MockAdapter([
      toolCallResponse('c1', 'todo_write', {
        todos: [
          { content: 'task 1', status: 'in_progress' },
          { content: 'task 2', status: 'pending' },
          { content: 'task 3', status: 'pending' },
        ],
      }),
      toolCallResponse('c2', 'bash', { command: 'echo ok' }),
    ]))
    await run(ctx, agent)
    const results = toolResults(agent)!
    expect(results).toHaveLength(2)
    expect(results[0]!.text).toBe('planned')
    expect(results[1]!.isError).toBe(true)
    expect(results[1]!.text).toContain("Gate 'todo-plan' blocked this call. Your todo tree contains 3 tasks (threshold: 3)")
    expect(results[1]!.text).toContain('create a detailed implementation plan first')
    expect(results[1]!.text).toContain('Delegate codebase exploration and plan authoring to a subagent')
    expect(results[1]!.text).toContain('plan_write')
  })

  it('counts nested children towards the todo threshold (1 root + 2 children = 3)', async () => {
    const { ctx, agent } = await harness(GATED, new MockAdapter([
      toolCallResponse('c1', 'todo_write', {
        todos: [
          {
            content: 'phase 1',
            status: 'in_progress',
            children: [
              { content: 'subtask 1.1', status: 'in_progress' },
              { content: 'subtask 1.2', status: 'pending' },
            ],
          },
        ],
      }),
      toolCallResponse('c2', 'bash', { command: 'echo ok' }),
    ]))
    await run(ctx, agent)
    const results = toolResults(agent)!
    expect(results).toHaveLength(2)
    expect(results[0]!.text).toBe('planned')
    expect(results[1]!.isError).toBe(true)
    expect(results[1]!.text).toContain('contains 3 tasks')
  })

  it('allows subagent and plan_write to proceed when plan is required, and unblocks mutation tools after plan_write', async () => {
    const { ctx, agent } = await harness(GATED, new MockAdapter([
      toolCallResponse('c1', 'todo_write', {
        todos: [
          { content: 'task 1', status: 'in_progress' },
          { content: 'task 2', status: 'pending' },
          { content: 'task 3', status: 'pending' },
        ],
      }),
      // subagent is called first to research and author the plan
      toolCallResponse('c2', 'subagent', { task: 'reconnaissance' }),
      // plan_write records the implementation plan
      toolCallResponse('c3', 'plan_write', { plan: '# Plan\n\n- step 1\n- step 2' }),
      // bash should now succeed
      toolCallResponse('c4', 'bash', { command: 'echo done' }),
    ]))
    await run(ctx, agent)
    const results = toolResults(agent)!
    expect(results).toHaveLength(4)
    expect(results[0]!.text).toBe('planned')
    expect(results[1]!.text).toBe('subagent finished')
    expect(results[1]!.isError).toBe(false)
    expect(results[2]!.text).toBe('plan recorded')
    expect(results[2]!.isError).toBe(false)
    expect(results[3]!.text).toBe('ran')
    expect(results[3]!.isError).toBe(false)
  })

  it('allows mutation tools without plan_write when requireImplementationPlan is disabled', async () => {
    const disabledPlanConfig: Config = {
      todoPlanGate: { enabled: true, tools: ['bash'], requireImplementationPlan: false },
      rules: [],
    }
    const { ctx, agent } = await harness(disabledPlanConfig, new MockAdapter([
      toolCallResponse('c1', 'todo_write', {
        todos: [
          { content: 'task 1', status: 'in_progress' },
          { content: 'task 2', status: 'pending' },
          { content: 'task 3', status: 'pending' },
          { content: 'task 4', status: 'pending' },
        ],
      }),
      toolCallResponse('c2', 'bash', { command: 'echo ok' }),
    ]))
    await run(ctx, agent)
    const results = toolResults(agent)!
    expect(results).toHaveLength(2)
    expect(results[0]!.text).toBe('planned')
    expect(results[1]!.isError).toBe(false)
    expect(results[1]!.text).toBe('ran')
  })

  it('countTodos correctly computes flat and nested counts', () => {
    expect(GatePolicy.countTodos(null)).toBe(0)
    expect(GatePolicy.countTodos(undefined)).toBe(0)
    expect(GatePolicy.countTodos([])).toBe(0)
    expect(GatePolicy.countTodos([{ content: '1' }, { content: '2' }])).toBe(2)
    expect(GatePolicy.countTodos([
      { content: '1', children: [{ content: '1.1' }, { content: '1.2', children: [{ content: '1.2.1' }] }] },
      { content: '2' },
    ])).toBe(5)
  })
})
