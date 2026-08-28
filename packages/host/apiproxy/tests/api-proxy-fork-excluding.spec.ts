/** session.forkExcluding: whole-turn exclusion, seed flattening, and fork-title chaining. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: merges the `session/title` event into the log vocabulary.
import type {} from '@deepseek-ai/dsh-session-title'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`fork-excluding-${String(nextRpc++)}`), payload }
}

async function composed(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, { id: session.id, session, status: 'idle', ctx: agentCtx })
      await options.setup?.(agentCtx)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('fork-excluding test sources are live')),
  })
  return ctx
}

function liveAgent(ctx: Context, id: string, turns: number): Session {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

/** Raw append for plugin-merged event types this test package does not type-merge. */
function appendRaw(session: Session, type: string, data: Record<string, unknown>): SessionEvent {
  return session.append(type as 'turn/start', data as never)
}

const api = (ctx: Context) => createApiProxy(ctx, {
  defaultModelSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
  cwd: '/tmp',
})

describe('sessions.forkExcluding', () => {
  it('drops the turn holding an excluded seq and titles the child [FORK n]', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-ex-source', 3)
    const response = await api(ctx).sessions.forkExcluding(request({ sessionId: source.id, excludeSeqs: [4] }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    const child = ctx.sessions.get(response.result.value.sessionId)
    expect(child?.events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'turn/end',
      'turn/start', 'user/message', 'turn/end',
      'session/end-seed',
    ])
    const texts = child?.events
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
      .map(event => event.data.content)
      .flat()
      .filter(block => block.type === 'text')
      .map(block => block.text)
    expect(texts).toEqual(['prompt 1', 'prompt 3'])
    expect(child?.header.parentSession).toBe(source.id)
    expect(response.result.value.title).toBe('[FORK 1] proj')
    expect(response.result.value.sessionId).toBe(child?.id)
    await ctx.fiber.dispose()
  })

  it('increments the fork number when the source title is itself a fork', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-ex-chained', 1)
    source.append('session/title', { title: '[FORK 2] Deep Dive', messageSeqs: [], source: { kind: 'user' } })
    const response = await api(ctx).sessions.forkExcluding(request({ sessionId: source.id, excludeSeqs: [1] }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    expect(response.result.value.title).toBe('[FORK 3] Deep Dive')
    await ctx.fiber.dispose()
  })

  it('flattens the seed: no compaction transactions, chunks, replaces, or stale citations', async () => {
    const ctx = await composed()
    const source = ctx.sessions.create(sid('session-ex-flat'), { meta: { cwd: '/proj' } })
    // Turn 1: one surfaced message, then a compaction transaction replacing it.
    source.append('turn/start', { turn: 1 })
    source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted away' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    appendRaw(source, 'compaction/start', { compactionId: 'compaction-1', turn: 1 })
    source.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'summary' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1] })
    appendRaw(source, 'compaction/end', { compactionId: 'compaction-1', turn: 1 })
    // Turn 2: retained, but carrying chunk telemetry and a source citation.
    source.append('turn/start', { turn: 2 })
    source.append('assistant/chunk', { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } })
    source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'kept prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append', sourceEventSeqs: [1] })
    source.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    ctx.agents.register({ id: source.id, session: source, status: 'idle', ctx } as Agent)

    const response = await api(ctx).sessions.forkExcluding(request({ sessionId: source.id, excludeSeqs: [1] }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    const child = ctx.sessions.get(response.result.value.sessionId)
    const seed = child?.events.filter(event => event.type !== 'session/end-seed') ?? []
    for (const event of seed) {
      expect(event.type.startsWith('compaction/')).toBe(false)
      expect(event.type).not.toBe('assistant/chunk')
      expect((event as { sourceEventSeqs?: number[] }).sourceEventSeqs).toBeUndefined()
      if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
        expect(event.surfaceOp).toBe('append')
      }
    }
    expect(seed.map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    await ctx.fiber.dispose()
  })

  it('rejects an empty exclusion selection', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-ex-empty', 1)
    const response = await api(ctx).sessions.forkExcluding(request({ sessionId: source.id, excludeSeqs: [] }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'fork-unavailable', details: { sessionId: source.id } },
    })
    await ctx.fiber.dispose()
  })

  it('rejects excluding every turn', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-ex-all', 1)
    const response = await api(ctx).sessions.forkExcluding(request({
      sessionId: source.id,
      excludeSeqs: source.events.map(event => event.seq),
    }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'fork-unavailable', details: { sessionId: source.id } },
    })
    if (!response.result.ok) expect(response.result.error.message).toMatch(/every turn/)
    await ctx.fiber.dispose()
  })
})
