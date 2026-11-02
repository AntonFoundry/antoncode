import { describe, expect, it, vi } from 'vitest'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createAgentMailGateway } from '../src/client/api-gateway.ts'

const ok = <T>(value: T) => ({ ok: true as const, value })
function fakeRemote() {
  const address = vi.fn(async () => ok({
    sessionId: 'session-1', workspaceId: 'workspace-1', inboxCursor: 0, unread: 0,
    peers: [{ sessionId: 'peer-1', workspaceId: 'workspace-2', transport: 'direct' }],
    hasMorePeers: false,
  }))
  const inbox = vi.fn(async (_sessionId: string, channel: 'local' | 'direct') => ok({
    messages: channel === 'local' ? [{ seq: 2, sender: 'local', senderWorkspaceId: 'workspace-1',
      body: 'hello', createdAt: 3 }] : [],
    cursor: 0, hasMore: false,
  }))
  const send = vi.fn(async () => ok({ seq: 2 }))
  const ack = vi.fn(async () => ok({ cursor: 2 }))
  const remote = { address, inbox, send, ack } as unknown as ClientRemote['agentMail']
  return { remote, address, inbox, send, ack }
}

describe('Agent Mail Remote gateway', () => {
  it('does not read or mutate queues before the session is opened', async () => {
    const fake = fakeRemote()
    const gateway = createAgentMailGateway(fake.remote)
    expect(gateway.authorization('session-1').state).toBe('unpaired')
    await expect(gateway.sendLocal({ sessionId: 'session-1', workspaceId: 'workspace-1',
      recipients: ['peer-1'], body: 'hello', workspaceWide: false })).rejects.toThrow('not authorized')
    expect(fake.address).not.toHaveBeenCalled()
    expect(fake.inbox).not.toHaveBeenCalled()
  })

  it('reads both channels, sends and acknowledges through the owner Remote', async () => {
    const fake = fakeRemote()
    const gateway = createAgentMailGateway(fake.remote)
    await gateway.authorize('session-1')
    expect(fake.address).toHaveBeenCalledWith('session-1', undefined)
    expect(fake.inbox).toHaveBeenCalledWith('session-1', 'local', undefined)
    expect(fake.inbox).toHaveBeenCalledWith('session-1', 'direct', undefined)
    expect(gateway.authorization('session-1')).toEqual({ state: 'authorized', address: 'session-1', workspaceId: 'workspace-1' })
    expect(gateway.peers('session-1')).toEqual([{ sessionId: 'peer-1', workspaceId: 'workspace-2' }])
    expect(gateway.inbox('session-1').local.messages[0]).toEqual({
      seq: 2, from: 'local', workspaceId: 'workspace-1', body: 'hello', at: 3,
    })
    await gateway.acknowledge({ sessionId: 'session-1', workspaceId: 'workspace-1', channel: 'direct', throughSeq: 3 })
    expect(fake.ack).toHaveBeenCalledWith('session-1', 'direct', 3)
    await gateway.sendDirect({ sessionId: 'session-1', workspaceId: 'workspace-1', recipient: 'peer-1', body: 'reply' })
    expect(fake.send).toHaveBeenCalledWith('session-1', 'direct', ['peer-1'], 'reply')
    await gateway.revoke('session-1')
    expect(gateway.authorization('session-1').state).toBe('revoked')
    await expect(gateway.refresh('session-1')).rejects.toThrow('not authorized')
  })

  it('returns to the unopened state when Host address resolution fails', async () => {
    const fake = fakeRemote()
    fake.address.mockRejectedValueOnce(new Error('session unavailable'))
    const gateway = createAgentMailGateway(fake.remote)
    await expect(gateway.authorize('session-1')).rejects.toThrow('session unavailable')
    expect(gateway.authorization('session-1').state).toBe('unpaired')
  })
})
