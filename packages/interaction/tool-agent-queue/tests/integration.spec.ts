import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentQueue from '../../agent-queue/src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as QueueTools from '../src/index.ts'

const workspaceId = WorkspaceId('ws-integrated')
const directory = '/queue/integration'
const members = [SessionId('root'), SessionId('alpha'), SessionId('beta')]
const active: { dispose(): Promise<void> }[] = []
afterEach(async () => { for (const fiber of active.splice(0)) await fiber.dispose() })
let counter = 0

async function setup() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domain)
  ctx.provide('storageDomain', domain)
  ctx.provide('workspaceRegistry', {
    resolveByPath: async (path: string) => path === directory
      ? { id: workspaceId, sessionIds: members, path: directory }
      : undefined,
  } as never)
  const live = new Map<string, Agent>()
  ctx.provide('agents', { get: (id: string) => live.get(id), list: () => [...live.values()] } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  active.push(await ctx.plugin(AgentQueue))
  active.push(await ctx.plugin(QueueTools))
  const agent = (name: string): Agent => {
    const id = SessionId(name)
    const value = { id, session: { header: { id, cwd: directory } } } as Agent
    live.set(id, value)
    return value
  }
  const execute = (name: string, arguments_: unknown, caller: Agent) => executeToolFixture(ctx, {
    name,
    arguments: arguments_,
    agent: caller,
    signal: new AbortController().signal,
    callId: ToolCallId(`queue-integration-${++counter}`),
  })
  return { ctx, agent, execute }
}

function body(result: { content: { type: string; text?: string }[] }): Record<string, unknown> {
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  return JSON.parse(text) as Record<string, unknown>
}

describe('real agent queue service through model tools', () => {
  it('addresses, subscribes, fans out, reads and acknowledges without waking', async () => {
    const { ctx, agent, execute } = await setup()
    const root = agent('root'); const alpha = agent('alpha'); const beta = agent('beta')
    const identity = await execute('agent_queue_address', {}, root)
    expect(identity.isError).toBe(false)
    expect(body(identity)).toMatchObject({ sessionId: root.id, workspaceId })
    for (const caller of [root, alpha, beta]) {
      expect((await execute('agent_queue_subscribe', { workspace_id: workspaceId }, caller)).isError).toBe(false)
    }
    const direct = await execute('agent_queue_send', {
      workspace_id: workspaceId, recipients: [alpha.id, beta.id], body: 'heads up',
    }, root)
    expect(direct.isError).toBe(false)
    expect(body(direct)).toMatchObject({ sender: root.id, recipients: [alpha.id, beta.id], seq: 1 })
    const topic = await execute('agent_queue_send', {
      workspace_id: workspaceId, workspace_wide: true, body: 'everyone',
    }, root)
    expect(topic.isError).toBe(false)
    const alphaRead = await execute('agent_queue_read', { workspace_id: workspaceId, limit: 10 }, alpha)
    expect(alphaRead.isError).toBe(false)
    expect((body(alphaRead).messages as { body: string }[]).map(message => message.body)).toEqual(['heads up', 'everyone'])
    const ack = await execute('agent_queue_ack', { workspace_id: workspaceId, through_seq: 1 }, alpha)
    expect(ack.isError).toBe(false)
    expect(body(ack)).toEqual({ cursor: 1 })
    const next = await execute('agent_queue_read', { workspace_id: workspaceId }, alpha)
    expect((body(next).messages as { body: string }[]).map(message => message.body)).toEqual(['everyone'])
    const betaRead = await execute('agent_queue_read', { workspace_id: workspaceId }, beta)
    expect((body(betaRead).messages as { body: string }[]).map(message => message.body)).toEqual(['heads up', 'everyone'])
    const rootRead = await execute('agent_queue_read', { workspace_id: workspaceId }, root)
    expect((body(rootRead).messages as { body: string }[]).map(message => message.body)).toEqual(['everyone'])
    expect(ctx.agentQueue).toBeDefined()
  })

  it('rejects mismatched workspace and agent impersonation at the real service boundary', async () => {
    const { agent, execute } = await setup()
    const root = agent('root'); const alpha = agent('alpha')
    expect((await execute('agent_queue_subscribe', { workspace_id: workspaceId }, alpha)).isError).toBe(false)
    expect((await execute('agent_queue_send', {
      workspace_id: 'wrong', recipients: [alpha.id], body: 'should fail',
    }, root)).isError).toBe(true)
    expect((await execute('agent_queue_ack', { workspace_id: 'wrong', through_seq: 0 }, alpha)).isError).toBe(true)
    expect((await execute('agent_queue_address', {}, { ...alpha })).isError).toBe(true)
  })
})
