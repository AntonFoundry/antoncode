import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentQueue from '../../agent-queue/src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as QueueTools from '../src/index.ts'

const id = WorkspaceId('digest-workspace')
const directory = '/queue/digest'
const members = [SessionId('root'), SessionId('child')]
const active: { dispose(): Promise<void> }[] = []
afterEach(async () => { for (const fiber of active.splice(0)) await fiber.dispose() })

async function setup() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domain)
  ctx.provide('storageDomain', domain)
  ctx.provide('workspaceRegistry', {
    resolveByPath: async (path: string) => path === directory
      ? { id, sessionIds: members, path: directory }
      : undefined,
  } as never)
  const live = new Map<string, Agent>()
  ctx.provide('agents', { get: (session: string) => live.get(session) } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  active.push(await ctx.plugin(AgentQueue))
  active.push(await ctx.plugin(QueueTools))
  const makeAgent = (name: string): Agent => {
    const sessionId = SessionId(name)
    const agent = { id: sessionId, session: { header: { id: sessionId, cwd: directory } } } as Agent
    live.set(sessionId, agent)
    return agent
  }
  const root = makeAgent('root')
  const child = makeAgent('child')
  return { ctx, root, child }
}

function notice(decision: PreStepDecision): string {
  if (decision.kind === 'reject') return ''
  return decision.messages.flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
}

async function propose(
  ctx: Context,
  agent: Agent,
  signal = new AbortController().signal,
  position: { turn: number; step: number } = { turn: 1, step: 1 },
): Promise<PreStepDecision> {
  return ctx.waterfall('agent/pre-step', {
    agent,
    ...position,
    modelSelection: { provider: 'mock', model: 'mock' },
    messages: [],
    signal,
  }, async () => ({
    kind: 'enter' as const,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'do work' }], source: { kind: 'user' } })],
  }))
}

describe('natural-step agent queue digest', () => {
  it('injects once per turn, replays next turn until explicit ack, and skips tool steps', async () => {
    const { ctx, root, child } = await setup()
    await ctx.agentQueue.publish(root, { recipients: [child.id], body: 'coordinate this file' })
    const first = notice(await propose(ctx, child))
    expect(first).toContain('coordinate this file')
    expect(first).toContain('replayed until agent_queue_ack')
    expect(notice(await propose(ctx, child, undefined, { turn: 1, step: 2 }))).not.toContain('coordinate this file')
    expect((await ctx.agentQueue.read(child)).messages).toHaveLength(1)
    expect(notice(await propose(ctx, child, undefined, { turn: 2, step: 1 }))).toContain('coordinate this file')
    await ctx.agentQueue.ack(child, id, 1)
    expect(notice(await propose(ctx, child, undefined, { turn: 3, step: 1 }))).not.toContain('coordinate this file')
  })

  it('does not append to rejected or cancelled decisions and leaves unread mail for replay', async () => {
    const { ctx, root, child } = await setup()
    await ctx.agentQueue.publish(root, { recipients: [child.id], body: 'must survive' })
    const reject = ctx.on('agent/pre-step', async () => ({ kind: 'reject' as const }))
    expect((await propose(ctx, child)).kind).toBe('reject')
    reject()
    const controller = new AbortController()
    const cancel = ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      controller.abort()
      return decision
    })
    expect(notice(await propose(ctx, child, controller.signal))).not.toContain('must survive')
    cancel()
    expect((await ctx.agentQueue.read(child)).messages).toHaveLength(1)
    expect(notice(await propose(ctx, child))).toContain('must survive')
  })

  it('never wakes an idle agent and bounds large digest bodies and page size', async () => {
    const { ctx, root, child } = await setup()
    for (let i = 0; i < 10; i++) {
      await ctx.agentQueue.publish(root, { recipients: [child.id], body: `${i}: ${'x'.repeat(1000)}` })
    }
    const result = await propose(ctx, child)
    const digest = notice(result)
    expect(digest).toContain('More messages remain')
    expect(digest).toContain('#8 from root')
    expect(digest).not.toContain('#9 from root')
    expect(digest.length).toBeLessThan(4000)
    expect((await ctx.agentQueue.read(child, { limit: 20 })).messages).toHaveLength(10)
  })
})
