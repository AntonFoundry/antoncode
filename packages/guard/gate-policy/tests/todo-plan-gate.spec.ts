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
    async execute(_args, exec) {
      exec.agent!.session.append('todo/write', { todos: [{ content: 'plan', status: 'in_progress' }] })
      return [{ type: 'text', text: 'planned' }]
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
})
