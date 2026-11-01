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
  await ctx.plugin(NativeToolExecutor)
  active.push(await ctx.plugin(AgentDirectQueue))
  active.push(await ctx.plugin(DirectTools))
  const agent = (name: string, cwd = homeDirectory): Agent => {
    const id = SessionId(name)
    const value = { id, session: { header: { id, cwd } } } as Agent
    live.set(id, value)
    return value
  }
  const execute = (name: string, arguments_: unknown, caller: Agent) => executeToolFixture(ctx, {
    name,
    arguments: arguments_,
    agent: caller,
    signal: new AbortController().signal,
    callId: ToolCallId(`dm-integration-${++counter}`),
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
      .toMatchObject({ sessionId: foreign.id, workspaceId: awayId, inboxCursor: 0, unread: 0 })
    const sent = await execute('agent_queue_dm_send', { recipients: [foreign.id], body: 'cross-workspace ping' }, root)
    expect(sent.isError).toBe(false)
    expect(body(sent)).toMatchObject({
      seq: 1, sender: root.id, senderWorkspaceId: homeId,
      recipients: [{ sessionId: foreign.id, workspaceId: awayId }],
    })
    const read = await execute('agent_queue_inbox_read', { limit: 10 }, foreign)
    expect((body(read).messages as { body: string }[]).map(message => message.body)).toEqual(['cross-workspace ping'])
    expect(body(await execute('agent_queue_inbox_ack', { through_seq: 1 }, foreign))).toEqual({ inboxCursor: 1 })
    const discovered = body(await execute('agent_queue_dm_address', {}, foreign))
    expect(discovered).toMatchObject({ sessionId: foreign.id, workspaceId: awayId, inboxCursor: 1, unread: 0 })
    // Discovery crosses the real service boundary: only the live, authorized
    // root is listed, carrying the transport that actually reaches it.
    expect(discovered.peers).toEqual([
      { sessionId: root.id, workspaceId: homeId, transport: 'direct' },
    ])
    expect(discovered.hasMorePeers).toBe(false)
    expect(discovered.nextPeerCursor).toBeUndefined()
    // A live session in an unregistered directory is never discoverable, and
    // a same-workspace peer is reported for the v1 tool instead.
    agent('stranger', '/dm/unregistered')
    const local = agent('alpha')
    const again = body(await execute('agent_queue_dm_address', {}, root))
    expect(again.peers).toEqual([
      { sessionId: foreign.id, workspaceId: awayId, transport: 'direct' },
      { sessionId: local.id, workspaceId: homeId, transport: 'workspace-queue' },
    ])
    expect(body(await execute('agent_queue_inbox_read', {}, foreign)).messages).toEqual([])
    const reply = await execute('agent_queue_dm_send', { recipients: [root.id], body: 'pong' }, foreign)
    expect(body(reply)).toMatchObject({ seq: 2, senderWorkspaceId: awayId })
    expect((body(await execute('agent_queue_inbox_read', {}, root)).messages as { body: string }[])
      .map(message => message.body)).toEqual(['pong'])
    expect(ctx.agentDirectQueue).toBeDefined()
  })

  it('walks every peer one keyset page at a time through the real service', async () => {
    const { agent, execute } = await setup()
    const root = agent('root')
    const local = agent('alpha')
    const foreign = agent('away-root', awayDirectory)
    home.sessionIds.push(SessionId('beta'))
    const other = agent('beta')
    try {
      const walked: { sessionId: string; workspaceId: string; transport: string }[] = []
      let cursor: unknown
      for (let page = 0; page < 6; page++) {
        const result = body(await execute('agent_queue_dm_address', {
          peer_limit: 1, ...(cursor === undefined ? {} : { peer_cursor: cursor }),
        }, root))
        walked.push(...result.peers as typeof walked)
        cursor = result.nextPeerCursor
        expect(result.hasMorePeers).toBe(cursor !== undefined)
        if (cursor === undefined) break
      }
      expect(cursor).toBeUndefined()
      // Three distinct peers reached across two workspaces, in one stable
      // order, with the transport of each preserved page by page.
      expect(walked).toEqual([
        { sessionId: foreign.id, workspaceId: awayId, transport: 'direct' },
        { sessionId: local.id, workspaceId: homeId, transport: 'workspace-queue' },
        { sessionId: other.id, workspaceId: homeId, transport: 'workspace-queue' },
      ])
      // A cursor the service never issued is rejected, not silently restarted.
      const forged = await execute('agent_queue_dm_address', { peer_cursor: 'not-a-cursor' }, root)
      expect(forged.isError).toBe(true)
      expect((await execute('agent_queue_dm_address', { peer_limit: 129 }, root)).isError).toBe(true)
    } finally { home.sessionIds.pop() }
  })

  it('rejects impersonation, same-workspace and unreachable addresses at the real boundary', async () => {
    const { agent, execute } = await setup()
    const root = agent('root')
    const local = agent('alpha')
    const sameWorkspace = await execute('agent_queue_dm_send', { recipients: [local.id], body: 'local' }, root)
    expect(sameWorkspace.isError).toBe(true)
    expect(JSON.stringify(sameWorkspace.content)).toContain('agent_queue_send')
    expect((await execute('agent_queue_dm_address', {}, { ...root })).isError).toBe(true)
    expect((await execute('agent_queue_dm_send', { recipients: [root.id], body: 'forged' }, { ...root })).isError).toBe(true)
    expect((await execute('agent_queue_dm_send', { recipients: ['ghost'], body: 'nowhere' }, root)).isError).toBe(true)
    expect((await execute('agent_queue_inbox_ack', { through_seq: 1 }, root)).isError).toBe(true)
    const stranger = agent('stranger', '/dm/unregistered')
    expect((await execute('agent_queue_inbox_read', {}, stranger)).isError).toBe(true)
  })
})
