import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentDirectQueue from '../../agent-queue/src/direct.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as DirectTools from '../src/direct.ts'

const homeId = WorkspaceId('ws-tools-home')
const awayId = WorkspaceId('ws-tools-away')
const homeDirectory = '/dm/home'
const awayDirectory = '/dm/away'
const home = { id: homeId, sessionIds: [SessionId('root'), SessionId('alpha')], path: homeDirectory }
const away = { id: awayId, sessionIds: [SessionId('away-root')], path: awayDirectory }
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
    resolveByPath: async (path: string) =>
      path === homeDirectory ? { ...home } : path === awayDirectory ? { ...away } : undefined,
    list: () => [{ ...home }, { ...away }],
  } as never)
  const live = new Map<string, Agent>()
  ctx.provide('agents', { get: (id: string) => live.get(id), list: () => [...live.values()] } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  active.push(await ctx.plugin(AgentDirectQueue))
  active.push(await ctx.plugin(DirectTools))
  const agent = (name: string, cwd = homeDirectory): Agent => {
    const id = SessionId(name)
    const value = { id, session: { header: { id, cwd } } } as Agent
    live.set(id, value)
    return value
  }
  const execute = (name: string, arguments_: unknown, caller: Agent) => ctx.tools.execute({
    name,
    arguments: arguments_,
    agent: caller,
    signal: new AbortController().signal,
    callId: CallId(`dm-integration-${++counter}`),
  })
  return { ctx, agent, execute }
}

const body = (result: { content: { type: string; text?: string }[] }): Record<string, unknown> =>
  JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('')) as Record<string, unknown>

describe('real direct mailbox through model tools', () => {
  it('addresses, sends across workspaces, reads, and acknowledges without waking', async () => {
    const { ctx, agent, execute } = await setup()
    const root = agent('root')
    const foreign = agent('away-root', awayDirectory)
    expect(body(await execute('agent_queue_dm_address', {}, foreign)))
      .toEqual({ sessionId: foreign.id, workspaceId: awayId, cursor: 0, unread: 0 })
    const sent = await execute('agent_queue_dm_send', { recipients: [foreign.id], body: 'cross-workspace ping' }, root)
    expect(sent.isError).toBe(false)
    expect(body(sent)).toMatchObject({
      seq: 1, sender: root.id, senderWorkspaceId: homeId,
      recipients: [{ sessionId: foreign.id, workspaceId: awayId }],
    })
    const read = await execute('agent_queue_inbox_read', { limit: 10 }, foreign)
    expect((body(read).messages as { body: string }[]).map(message => message.body)).toEqual(['cross-workspace ping'])
    expect(body(await execute('agent_queue_inbox_ack', { through_seq: 1 }, foreign))).toEqual({ cursor: 1 })
    expect(body(await execute('agent_queue_inbox_read', {}, foreign)).messages).toEqual([])
    const reply = await execute('agent_queue_dm_send', { recipients: [root.id], body: 'pong' }, foreign)
    expect(body(reply)).toMatchObject({ seq: 2, senderWorkspaceId: awayId })
    expect((body(await execute('agent_queue_inbox_read', {}, root)).messages as { body: string }[])
      .map(message => message.body)).toEqual(['pong'])
    expect(ctx.agentDirectQueue).toBeDefined()
  })

  it('rejects impersonation and unreachable addresses at the real service boundary', async () => {
    const { agent, execute } = await setup()
    const root = agent('root')
    expect((await execute('agent_queue_dm_address', {}, { ...root } as Agent)).isError).toBe(true)
    expect((await execute('agent_queue_dm_send', { recipients: [root.id], body: 'forged' }, { ...root } as Agent)).isError).toBe(true)
    expect((await execute('agent_queue_dm_send', { recipients: ['ghost'], body: 'nowhere' }, root)).isError).toBe(true)
    expect((await execute('agent_queue_inbox_ack', { through_seq: 1 }, root)).isError).toBe(true)
    const stranger = agent('stranger', '/dm/unregistered')
    expect((await execute('agent_queue_inbox_read', {}, stranger)).isError).toBe(true)
  })
})
