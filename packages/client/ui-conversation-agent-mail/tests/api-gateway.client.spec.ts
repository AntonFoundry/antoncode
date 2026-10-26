import { describe, expect, it, vi } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { createAgentMailGateway } from '../src/client/api-gateway.ts'

const ok = <T>(value: T) => ({ result: { ok: true as const, value } })
function fakeClient() {
  const authorize = vi.fn(async () => ok({ grant: 'grant-1' }))
  const begin = vi.fn(async () => ok({ requestId: 'req-1', expiresAt: 10000 }))
  const redeem = vi.fn(async () => ok({ grant: 'grant-1' }))
  const revoke = vi.fn(async () => ok({ revoked: true }))
  const address = vi.fn(async () => ok({
    sessionId: 'session-1', workspaceId: 'workspace-1', inboxCursor: 0, unread: 0,
    peers: [{ sessionId: 'peer-1', workspaceId: 'workspace-2', transport: 'direct' }],
    hasMorePeers: false,
  }))
  const inbox = vi.fn(async ({ channel }: { channel: 'local' | 'direct' }) => ok({
    messages: channel === 'local' ? [{ seq: 2, sender: 'local', senderWorkspaceId: 'workspace-1',
      body: 'hello', createdAt: 3 }] : [],
    cursor: 0, hasMore: false,
  }))
  const send = vi.fn(async () => ok({ seq: 2 }))
  const ack = vi.fn(async () => ok({ cursor: 2 }))
  const api = { agentMail: { authorize, begin, redeem, revoke, address, inbox, send, ack } } as unknown as IApiClient
  return { api, authorize, begin, redeem, revoke, address, inbox, send, ack }
}

describe('Agent Mail typed client gateway', () => {
  it('has no queue access before the Host authorizes this session', async () => {
    const fake = fakeClient()
    const gateway = createAgentMailGateway(fake.api)
    expect(gateway.authorization('session-1').state).toBe('unpaired')
    expect(gateway.inbox('session-1').local.messages).toHaveLength(0)
    expect(gateway.peers('session-1')).toHaveLength(0)
    await expect(gateway.sendLocal({ sessionId: 'session-1', workspaceId: 'workspace-1',
      recipients: ['peer-1'], body: 'hello', workspaceWide: false })).rejects.toThrow('not authorized')
    expect(fake.address).not.toHaveBeenCalled()
    expect(fake.inbox).not.toHaveBeenCalled()
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('authorizes locally, then passes the grant on each operation and keeps cursors separate', async () => {
    const fake = fakeClient()
    const gateway = createAgentMailGateway(fake.api)
    await gateway.authorize('session-1')
    expect(fake.authorize).toHaveBeenCalledWith({ sessionId: 'session-1', operations: [
      'address', 'local-read', 'local-send', 'local-ack', 'direct-read', 'direct-send', 'direct-ack',
    ] })
    expect(fake.begin).not.toHaveBeenCalled()
    expect(fake.redeem).not.toHaveBeenCalled()
    expect(gateway.authorization('session-1')).toEqual({ state: 'authorized', address: 'session-1', workspaceId: 'workspace-1' })
    expect(gateway.peers('session-1')).toEqual([{ sessionId: 'peer-1', workspaceId: 'workspace-2' }])
    expect(gateway.inbox('session-1').local.messages[0]).toEqual({
      seq: 2, from: 'local', workspaceId: 'workspace-1', body: 'hello', at: 3,
    })
    expect(fake.inbox).toHaveBeenCalledWith({ sessionId: 'session-1', grant: 'grant-1', channel: 'local', limit: 100 })
    expect(fake.inbox).toHaveBeenCalledWith({ sessionId: 'session-1', grant: 'grant-1', channel: 'direct', limit: 100 })
    await gateway.acknowledge({ sessionId: 'session-1', workspaceId: 'workspace-1', channel: 'direct', throughSeq: 3 })
    expect(fake.ack).toHaveBeenCalledWith({ sessionId: 'session-1', grant: 'grant-1', channel: 'direct', throughSeq: 3 })
    await gateway.sendDirect({ sessionId: 'session-1', workspaceId: 'workspace-1', recipient: 'peer-1', body: 'reply' })
    expect(fake.send).toHaveBeenCalledWith({ sessionId: 'session-1', grant: 'grant-1',
      channel: 'direct', recipients: ['peer-1'], body: 'reply' })
    await gateway.revoke('session-1')
    expect(fake.revoke).toHaveBeenCalledWith({ sessionId: 'session-1', grant: 'grant-1' })
    expect(gateway.authorization('session-1').state).toBe('revoked')
    await expect(gateway.refresh('session-1')).rejects.toThrow('not authorized')
  })

  it('fails closed if address verification fails after authorization', async () => {
    const fake = fakeClient()
    fake.address.mockRejectedValueOnce(new Error('origin refused'))
    const gateway = createAgentMailGateway(fake.api)
    await expect(gateway.authorize('session-1')).rejects.toThrow('origin refused')
    expect(gateway.authorization('session-1').state).toBe('unpaired')
  })
})
