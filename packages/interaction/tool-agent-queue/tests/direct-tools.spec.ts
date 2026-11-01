import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as DirectTools from '../src/direct.ts'

const agent = { id: 'session-a', session: { header: { id: 'session-a', cwd: '/home' } } } as never
const away = { id: 'session-b', session: { header: { id: 'session-b', cwd: '/away' } } } as never
let call = 0

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  // The mock stays behind the service boundary: a tool cannot manufacture a
  // sender, choose a recipient workspace, or move another session's cursor.
  const direct = {
    address: vi.fn(async (caller: { id: string }, options: { peerCursor?: string; peerLimit?: number } = {}) => ({
      sessionId: caller.id, workspaceId: 'ws-home', inboxCursor: 2, unread: 1,
      peers: [
        { sessionId: 'session-b', workspaceId: 'ws-away', transport: 'direct' },
        { sessionId: 'session-local', workspaceId: 'ws-home', transport: 'workspace-queue' },
      ],
      ...(options.peerCursor === undefined
        ? { hasMorePeers: true, nextPeerCursor: 'cursor-page-2' }
        : { hasMorePeers: false }),
    })),
    send: vi.fn(async (_agent: unknown, request: { recipients: string[]; body: string }) => ({
      id: 'dm-1', seq: 3, sender: 'session-a', senderWorkspaceId: 'ws-home', body: request.body, createdAt: 0,
      recipients: request.recipients.map(sessionId => ({ sessionId, workspaceId: 'ws-away' })),
    })),
    inbox: vi.fn(async () => ({
      messages: [{ id: 'dm-1', seq: 3, recipients: [{ sessionId: 'session-a', workspaceId: 'ws-home' }] }],
      inboxCursor: 2, hasMore: false,
    })),
    ackInbox: vi.fn(async () => 3),
  }
  ctx.provide('agentDirectQueue', direct as never)
  const fiber = await ctx.plugin(DirectTools)
  const execute = (name: string, args: unknown, caller?: unknown) => executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`dm-call-${++call}`),
    name,
    arguments: args,
    ...(caller === undefined ? {} : { agent: caller as never }),
  })
  return { ctx, direct, execute, fiber }
}

const text = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.filter(block => block.type === 'text').map(block => block.text).join('')

describe('model-facing cross-workspace direct message tools', () => {
  it('registers four direct tools that carry no workspace parameter', async () => {
    const { ctx } = await setup()
    const schemas = ctx.tools.schemas().filter(tool => tool.name.startsWith('agent_queue_'))
    expect(schemas.map(tool => tool.name).sort())
      .toEqual(['agent_queue_dm_address', 'agent_queue_dm_send', 'agent_queue_inbox_ack', 'agent_queue_inbox_read'])
    expect(JSON.stringify(schemas)).not.toContain('workspace_id')
    // The read/ack contracts name the direct position explicitly so a model
    // cannot confuse it with the per-workspace cursor of agent_queue_read.
    const names = schemas.map(tool => JSON.stringify(tool))
    expect(names.filter(schema => schema.includes('inboxCursor'))).toHaveLength(3)
  })

  it('rejects an agentless call and passes the exact calling Agent to the service', async () => {
    const { direct, execute } = await setup()
    expect((await execute('agent_queue_dm_address', {})).isError).toBe(true)
    expect(direct.address).not.toHaveBeenCalled()
    const own = await execute('agent_queue_dm_address', {}, agent)
    expect(own.isError).toBe(false)
    expect(text(own)).toContain('"inboxCursor":2')
    expect(text(own)).toContain('"unread":1')
    // Discovery reaches the model with each peer's workspace and transport, so
    // a local peer is routed to the v1 tool instead of the direct ledger.
    expect(text(own)).toContain('"transport":"direct"')
    expect(text(own)).toContain('"transport":"workspace-queue"')
    expect(text(own)).toContain('"hasMorePeers":true')
    expect(text(own)).toContain('"nextPeerCursor":"cursor-page-2"')
    expect((await execute('agent_queue_dm_send', { recipients: ['session-b'], body: 'hi' })).isError).toBe(true)
    expect((await execute('agent_queue_inbox_read', {})).isError).toBe(true)
    expect((await execute('agent_queue_inbox_ack', { through_seq: 1 })).isError).toBe(true)
    expect(direct.address).toHaveBeenCalledWith(agent, {})
    expect(direct.send).not.toHaveBeenCalled()
  })

  it('declares peer paging, passes the cursor and limit through, and rejects invalid ones', async () => {
    const { ctx, direct, execute } = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'agent_queue_dm_address')
    expect(JSON.stringify(schema)).toContain('peer_cursor')
    expect(JSON.stringify(schema)).toContain('peer_limit')
    const paged = await execute('agent_queue_dm_address', { peer_cursor: 'cursor-page-2', peer_limit: 128 }, agent)
    expect(paged.isError).toBe(false)
    expect(direct.address).toHaveBeenCalledWith(agent, { peerCursor: 'cursor-page-2', peerLimit: 128 })
    // The final page reports the end of the walk and omits a next cursor.
    expect(text(paged)).toContain('"hasMorePeers":false')
    expect(text(paged)).not.toContain('nextPeerCursor')
    // Only the named controls are forwarded; neither is invented when absent.
    expect((await execute('agent_queue_dm_address', { peer_limit: 1 }, agent)).isError).toBe(false)
    expect(direct.address).toHaveBeenNthCalledWith(2, agent, { peerLimit: 1 })
    direct.address.mockClear()
    for (const args of [
      { peer_cursor: '' }, { peer_cursor: '   ' }, { peer_cursor: 'c'.repeat(4097) },
      { peer_limit: 0 }, { peer_limit: -1 }, { peer_limit: 1.5 }, { peer_limit: 129 },
    ]) {
      expect((await execute('agent_queue_dm_address', args, agent)).isError).toBe(true)
    }
    expect(direct.address).not.toHaveBeenCalled()
  })

  it('sends to session addresses in other workspaces and echoes the resolved addresses', async () => {
    const { direct, execute } = await setup()
    const sent = await execute('agent_queue_dm_send', { recipients: ['session-b', 'session-c'], body: 'cross' }, agent)
    expect(sent.isError).toBe(false)
    expect(direct.send).toHaveBeenCalledWith(agent, { recipients: ['session-b', 'session-c'], body: 'cross' })
    expect(text(sent)).toContain('"workspaceId":"ws-away"')
    expect((await execute('agent_queue_dm_send', { recipients: ['session-b'], body: 'from away' }, away)).isError).toBe(false)
    expect(direct.send).toHaveBeenNthCalledWith(2, away, { recipients: ['session-b'], body: 'from away' })
    expect(Object.keys(direct)).toEqual(['address', 'send', 'inbox', 'ackInbox'])
  })

  it('rejects invalid sends before reaching the service', async () => {
    const { direct, execute } = await setup()
    for (const args of [
      { recipients: [], body: 'hello' },
      { recipients: ['session-b', 'session-b'], body: 'hello' },
      { recipients: ['session-b'], body: ' ' },
      { recipients: ['session-b'], body: 'x'.repeat(65537) },
      { recipients: [' '], body: 'hello' },
      { recipients: ['x'.repeat(257)], body: 'hello' },
      { recipients: Array.from({ length: 33 }, (_, index) => `session-${index}`), body: 'hello' },
    ]) {
      expect((await execute('agent_queue_dm_send', args, agent)).isError).toBe(true)
    }
    expect(direct.send).not.toHaveBeenCalled()
  })

  it('reads and acknowledges through the caller’s durable inbox cursor', async () => {
    const { direct, execute } = await setup()
    const read = await execute('agent_queue_inbox_read', { cursor: 1, limit: 5 }, agent)
    expect(read.isError).toBe(false)
    expect(direct.inbox).toHaveBeenCalledWith(agent, { cursor: 1, limit: 5 })
    expect(text(read)).toContain('"inboxCursor":2')
    expect(text(read)).not.toContain('"cursor"')
    expect((await execute('agent_queue_inbox_read', {}, agent)).isError).toBe(false)
    expect(direct.inbox).toHaveBeenNthCalledWith(2, agent, {})
    const ack = await execute('agent_queue_inbox_ack', { through_seq: 3 }, agent)
    expect(ack.isError).toBe(false)
    expect(direct.ackInbox).toHaveBeenCalledWith(agent, 3)
    expect(text(ack)).toContain('"inboxCursor":3')
    expect((await execute('agent_queue_inbox_read', { limit: 101 }, agent)).isError).toBe(true)
    expect((await execute('agent_queue_inbox_read', { cursor: -1 }, agent)).isError).toBe(true)
    expect((await execute('agent_queue_inbox_ack', { through_seq: -1 }, agent)).isError).toBe(true)
  })

  it('removes every direct tool when the fiber is disposed', async () => {
    const { ctx, fiber } = await setup()
    await fiber.dispose()
    expect(ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('agent_queue_'))).toEqual([])
  })
})
