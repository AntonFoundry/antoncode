import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as GatePolicy from '@deepseek-ai/dsh-gate-policy'
import type { Config } from '@deepseek-ai/dsh-gate-policy'

/**
 * Behavior suite for the gate-policy guard, driven through a real agent loop
 * against a scripted mock adapter: a matching call is denied with the rule's
 * checklist as the tool-result error text, a non-matching call proceeds, and
 * malformed rules fail at plugin load.
 */

const RULES: Config = {
  rules: [{
    name: 'push-gate',
    tools: ['bash'],
    commandPatterns: ['git\\s+push'],
    checklist: '- Run the test suite and show it passing\n- Re-state what is being pushed',
  }],
}

/** Boot the core spine + the guard; the caller registers adapters and agents. */
async function harness(config: Config, adapter: MockAdapter): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(GatePolicy, config)
  ctx.tools.register(defineContentToolFixture({ name: 'bash', description: 'b', parameters: {}, async execute() { return [{ type: 'text', text: 'ran' }] } }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('gate-test'), { provider: 'mock', model: 'mock' })
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

describe('gate-policy', () => {
  it('denies a matching call with the rule checklist as the tool-result error', async () => {
    const { ctx, agent } = await harness(RULES, new MockAdapter([toolCallResponse('c1', 'bash', { command: 'git push origin main' })]))
    await run(ctx, agent)
    const results = toolResults(agent)!
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(true)
    expect(results[0]!.text).toContain("Gate 'push-gate' blocked this call")
    expect(results[0]!.text).toContain('Run the test suite')
    expect(results[0]!.text).toContain('retry this exact call')
  })

  it('lets a non-matching call through untouched', async () => {
    const { ctx, agent } = await harness(RULES, new MockAdapter([toolCallResponse('c1', 'bash', { command: 'git status --short' })]))
    await run(ctx, agent)
    const results = toolResults(agent)!
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(false)
    expect(results[0]!.text).toBe('ran')
  })

  it('fails loud at load on an invalid rule regex', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(GatePolicy, {
      rules: [{ name: 'broken', commandPatterns: ['git\\s+(push'], checklist: 'x' }],
    })).rejects.toThrow(/invalid `commandPatterns`/)
  })

  it('fails loud at load on an empty checklist', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(GatePolicy, {
      rules: [{ name: 'empty', commandPatterns: ['x'], checklist: '   ' }],
    })).rejects.toThrow(/non-empty `checklist`/)
  })

  it('accepts an empty rules list and gates nothing', async () => {
    const { ctx, agent } = await harness({ rules: [] }, new MockAdapter([toolCallResponse('c1', 'bash', { command: 'git push origin main' }), textResponse('done')]))
    await run(ctx, agent)
    expect(toolResults(agent)![0]!.isError).toBe(false)
  })
})
