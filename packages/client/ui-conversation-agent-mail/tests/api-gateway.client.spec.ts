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
    expect(fake.address).toHaveBeenCalledWith('session-1', undefined, undefined)
    expect(fake.inbox).toHaveBeenCalledWith('session-1', 'local', undefined, undefined)
    expect(fake.inbox).toHaveBeenCalledWith('session-1', 'direct', undefined, undefined)
    expect(gateway.authorization('session-1')).toEqual({ state: 'authorized', address: 'session-1', workspaceId: 'workspace-1' })
    expect(gateway.peers('session-1')).toEqual([{ sessionId: 'peer-1', workspaceId: 'workspace-2', transport: 'direct' }])
    expect(gateway.inbox('session-1').local.messages[0]).toEqual({
      seq: 2, from: 'local', workspaceId: 'workspace-1', body: 'hello', at: 3,
    })
    await gateway.acknowledge({ sessionId: 'session-1', workspaceId: 'workspace-1', channel: 'direct', throughSeq: 3 })
    expect(fake.ack).toHaveBeenCalledWith('session-1', 'direct', 3)
    await gateway.sendDirect({ sessionId: 'session-1', workspaceId: 'workspace-1', recipients: ['peer-1'], body: 'reply' })
    expect(fake.send).toHaveBeenCalledWith('session-1', 'direct', ['peer-1'], 'reply', false)
    await gateway.revoke('session-1')
    expect(gateway.authorization('session-1').state).toBe('revoked')
    await expect(gateway.refresh('session-1')).rejects.toThrow('not authorized')
  })

  it.each(['local', 'direct'] as const)('retains a committed %s receipt when refresh fails without retrying delivery', async (channel) => {
    const fake = fakeRemote()
    const gateway = createAgentMailGateway(fake.remote)
    await gateway.authorize('session-1')
    const before = gateway.inbox('session-1')
    const listener = vi.fn()
    gateway.subscribeInbox(listener)
    fake.address.mockRejectedValueOnce(new Error('refresh unavailable'))
    const outcome = channel === 'local'
      ? gateway.sendLocal({ sessionId: 'session-1', workspaceId: 'workspace-1', recipients: ['local'], body: 'hello', workspaceWide: false })
      : gateway.sendDirect({ sessionId: 'session-1', workspaceId: 'workspace-1', recipients: ['peer-1'], body: 'hello' })
    await expect(outcome).resolves.toEqual({ receipt: { seq: 2 }, refreshError: 'refresh unavailable' })
    expect(fake.send).toHaveBeenCalledTimes(1)
    expect(gateway.inbox('session-1')).toMatchObject({ local: before.local, direct: before.direct, refreshError: 'refresh unavailable' })
    expect(gateway.inbox('session-1').sent).toHaveLength(1)
    expect(listener).toHaveBeenCalled()
    await gateway.refresh('session-1')
    expect(gateway.inbox('session-1').refreshError).toBeUndefined()
  })

  it('publishes a gateway-owned receipt before refresh settles and clears it on revoke', async () => {
    const fake = fakeRemote()
    const gateway = createAgentMailGateway(fake.remote)
    await gateway.authorize('session-1')
    const started = Promise.withResolvers<undefined>()
    const pending = Promise.withResolvers<undefined>()
    fake.address.mockImplementationOnce(async () => {
      started.resolve(undefined)
      await pending.promise
      return ok({ sessionId: 'session-1', workspaceId: 'workspace-1', inboxCursor: 0, unread: 0,
        peers: [], hasMorePeers: false })
    })
    const sending = gateway.sendDirect({ sessionId: 'session-1', workspaceId: 'workspace-1', recipients: ['peer-1'], body: 'committed' })
    await started.promise
    expect(gateway.inbox('session-1').sent).toMatchObject([
      { key: 'queue:direct:workspace-1:2', channel: 'direct', from: 'session-1', to: ['peer-1'], body: 'committed', seq: 2 },
    ])
    pending.resolve(undefined)
    await sending
    expect(gateway.inbox('session-1').sent).toHaveLength(1)
    await gateway.revoke('session-1')
    expect(gateway.inbox('session-1').sent).toEqual([])
  })

  it('keeps concurrent committed receipts when another operation refreshes the same authorization', async () => {
    const fake = fakeRemote()
    const gateway = createAgentMailGateway(fake.remote)
    await gateway.authorize('session-1')
    const pending = Promise.withResolvers<ReturnType<typeof ok<{ seq: number }>>>()
    fake.send.mockImplementationOnce(() => pending.promise)
    const sending = gateway.sendDirect({ sessionId: 'session-1', workspaceId: 'workspace-1', recipients: ['peer-1'], body: 'first' })
    await gateway.sendDirect({ sessionId: 'session-1', workspaceId: 'workspace-1', recipients: ['peer-2'], body: 'second' })
    pending.resolve(ok({ seq: 3 }))
    await sending
    expect(gateway.inbox('session-1').sent.map(entry => entry.seq)).toEqual([2, 3])
  })

  it('does not republish an old receipt or refresh after revocation and reauthorization', async () => {
    const fake = fakeRemote()
    const gateway = createAgentMailGateway(fake.remote)
    await gateway.authorize('session-1')
    const pending = Promise.withResolvers<ReturnType<typeof ok<{ seq: number }>>>()
    fake.send.mockImplementationOnce(() => pending.promise)
    const sending = gateway.sendDirect({ sessionId: 'session-1', workspaceId: 'workspace-1', recipients: ['peer-1'], body: 'old' })
    await gateway.revoke('session-1')
    await gateway.authorize('session-1')
    pending.resolve(ok({ seq: 3 }))
    await expect(sending).resolves.toEqual({ receipt: { seq: 3 } })
    expect(gateway.inbox('session-1').sent).toEqual([])
  })

  it('does not let an older refresh hide a newer mailbox page', async () => {
    const fake = fakeRemote()
    const gateway = createAgentMailGateway(fake.remote)
    await gateway.authorize('session-1')
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof fake.address>>>()
    fake.address.mockImplementationOnce(() => pending.promise)
    const older = gateway.refresh('session-1')
    fake.inbox.mockImplementation(async (_sessionId, channel) => ok({
      messages: channel === 'local' ? [{ seq: 9, sender: 'local', senderWorkspaceId: 'workspace-1', body: 'newer', createdAt: 9 }] : [],
      cursor: 0, hasMore: false,
    }))
    await gateway.refresh('session-1')
    pending.resolve(ok({ sessionId: 'session-1', workspaceId: 'workspace-1', inboxCursor: 0, unread: 0, peers: [], hasMorePeers: false }))
    await older
    expect(gateway.inbox('session-1').local.messages[0]?.seq).toBe(9)
  })

  it('does not restore an old refresh warning after a newer refresh succeeds', async () => {
    const fake = fakeRemote()
    const gateway = createAgentMailGateway(fake.remote)
    await gateway.authorize('session-1')
    const started = Promise.withResolvers<undefined>()
    const pending = Promise.withResolvers<never>()
    fake.address.mockImplementationOnce(() => { started.resolve(undefined); return pending.promise })
    const sending = gateway.sendDirect({ sessionId: 'session-1', workspaceId: 'workspace-1', recipients: ['peer-1'], body: 'old' })
    await started.promise
    await gateway.refresh('session-1')
    pending.reject(new Error('old refresh failed'))
    await expect(sending).resolves.toEqual({ receipt: { seq: 2 }, refreshError: 'old refresh failed' })
    expect(gateway.inbox('session-1').refreshError).toBeUndefined()
  })

  it('rejects a commit refusal without claiming a receipt or refresh failure', async () => {
    const fake = fakeRemote()
    const gateway = createAgentMailGateway(fake.remote)
    await gateway.authorize('session-1')
    fake.send.mockRejectedValueOnce(new Error('delivery refused'))
    await expect(gateway.sendDirect({ sessionId: 'session-1', workspaceId: 'workspace-1', recipients: ['peer-1'], body: 'hello' }))
      .rejects.toThrow('delivery refused')
    expect(gateway.inbox('session-1').refreshError).toBeUndefined()
    expect(fake.address).toHaveBeenCalledTimes(1)
  })

  it('returns to the unopened state when Host address resolution fails', async () => {
    const fake = fakeRemote()
    fake.address.mockRejectedValueOnce(new Error('session unavailable'))
    const gateway = createAgentMailGateway(fake.remote)
    await expect(gateway.authorize('session-1')).rejects.toThrow('session unavailable')
    expect(gateway.authorization('session-1').state).toBe('unpaired')
  })
})

it('publishes one stable aggregate source and preserves authoritative peer transport', async () => {
  const fake = fakeRemote()
  const gateway = createAgentMailGateway(fake.remote)
  const source = gateway.source('session-1')
  expect(gateway.source('session-1')).toBe(source)
  expect(source.getSnapshot()).toBe(source.getSnapshot())
  const changed = vi.fn()
  const release = source.subscribe(changed)
  await gateway.authorize('session-1')
  const current = source.getSnapshot()
  expect(current.authorization.state).toBe('authorized')
  expect(current.peers).toEqual([{ sessionId: 'peer-1', workspaceId: 'workspace-2', transport: 'direct' }])
  expect(source.getSnapshot()).toBe(current)
  expect(Object.isFrozen(current.inbox.local.messages)).toBe(true)
  expect(Object.isFrozen(current.peers[0])).toBe(true)
  expect(changed).toHaveBeenCalled()
  release()
  await gateway.dispose()
  expect(source.getSnapshot().authorization.state).toBe('revoked')
  expect(source.getSnapshot().inbox.sent).toEqual([])
})

it('does not publish a query from an aborted watch generation even if the Remote ignores cancellation', async () => {
  const fake = fakeRemote()
  const gateway = createAgentMailGateway(fake.remote)
  await gateway.authorize('session-1')
  const before = gateway.inbox('session-1')
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof fake.address>>>()
  fake.address.mockImplementationOnce(() => pending.promise)
  const controller = new AbortController()
  const refreshing = gateway.refresh('session-1', controller.signal)
  controller.abort()
  pending.resolve(ok({ sessionId: 'session-1', workspaceId: 'different-workspace', inboxCursor: 0, unread: 0, peers: [], hasMorePeers: false }))
  await refreshing
  expect(gateway.authorization('session-1').workspaceId).toBe('workspace-1')
  expect(gateway.inbox('session-1')).toBe(before)
  await gateway.dispose()
})

it('clears presentation idempotently before authorization and refuses new sources after disposal', async () => {
  const fake = fakeRemote()
  const gateway = createAgentMailGateway(fake.remote)
  await expect(gateway.revoke('session-1')).resolves.toBeUndefined()
  await expect(gateway.revoke('session-1')).resolves.toBeUndefined()
  expect(gateway.source('session-1').getSnapshot().authorization.state).toBe('revoked')
  expect(fake.address).not.toHaveBeenCalled()
  await gateway.dispose()
  expect(() => gateway.source('new-session')).toThrow('disposed')
})
