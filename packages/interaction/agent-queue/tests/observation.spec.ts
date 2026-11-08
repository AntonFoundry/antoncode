/** Read-only mailbox observation behavior through real queue providers. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PeerId, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'mail-test-guest': { readonly kind: 'mail-test-guest' }
  }
}
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import AgentQueue from '../src/index.ts'
import AgentDirectQueue from '../src/direct.ts'
import AgentMailRemote from '../src/mail-remote.ts'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { ownerPeer } from '../../../api/gateway/tests/peer.ts'

const homeId = WorkspaceId('home')
const awayId = WorkspaceId('away')
const contexts = new Set<Context>()
afterEach(async () => { for (const ctx of contexts) await ctx.fiber.dispose(); contexts.clear() })

async function setup() {
  const ctx = new Context(); contexts.add(ctx)
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility); ctx.provide('storageDomain', facility)
  const live = new Map<string, Agent>()
  const home = { id: homeId, path: '/mail/home', sessionIds: [SessionId('root'), SessionId('local')] }
  const away = { id: awayId, path: '/mail/away', sessionIds: [SessionId('foreign')] }
  const resolveByPath = vi.fn(async (cwd: string) => cwd === home.path ? home : cwd === away.path ? away : undefined)
  await ctx.plugin({
    name: 'mail-test-workspaces',
    apply(provider: Context) { provider.provide('workspaceRegistry', { resolveByPath } as never) },
  })
  ctx.provide('agents', { get: (id: string) => live.get(id), list: () => [...live.values()] } as never)
  await ctx.plugin(TypertRegistry)
  const localFiber = await ctx.plugin(AgentQueue)
  const directFiber = await ctx.plugin(AgentDirectQueue)
  const agent = (name: string, cwd = home.path): Agent => {
    const id = SessionId(name)
    const value = { id, session: { header: { id, cwd } } } as Agent
    live.set(id, value); return value
  }
  const root = agent('root'); const local = agent('local'); const foreign = agent('foreign', away.path)
  const remoteFiber = await ctx.plugin(AgentMailRemote)
  const remote = remoteFiber.ctx.get('agentMailRemote') as AgentMailRemote
  return { ctx, root, local, foreign, remote, live, home, pool, resolveByPath, localFiber, directFiber }
}

describe('read-only mail observation', () => {
  it('opens an owner watch through the Gateway on a guarded plugin Service', async () => {
    const { ctx, root } = await setup()
    await ctx.plugin(RemoteAccessService)
    await ctx.plugin(TypertGatewayService)
    const controller = new AbortController()
    const stream = await ctx.typertGateway.stream({
      peer: ownerPeer(ctx), namespace: 'agentMail', method: 'watch',
      args: { sessionId: root.id }, signal: controller.signal,
    })
    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { revision: 0 } })
    controller.abort()
    await iterator.return?.()
  })

  it('does not create delivery accounts or opt into broadcasts and survives durable unsubscribe', async () => {
    const { ctx, root, local } = await setup()
    const listener = vi.fn(); const stop = await ctx.agentQueue.observe(local, listener)
    await expect(ctx.agentQueue.read(local)).rejects.toThrow('no addressed messages')
    await expect(ctx.agentQueue.publish(root, { workspaceWide: true, body: 'no opt-in' })).rejects.toThrow('no current subscribers')
    const sent = await ctx.agentQueue.publish(root, { recipients: [local.id], body: 'first' })
    expect(listener).toHaveBeenLastCalledWith({ workspaceId: homeId, seq: sent.seq })
    await ctx.agentQueue.ack(local, homeId, sent.seq)
    expect(listener).toHaveBeenCalledTimes(2)
    await ctx.agentQueue.subscribe(local)
    await ctx.agentQueue.unsubscribe(local)
    await ctx.agentQueue.publish(root, { recipients: [local.id], body: 'after unsubscribe' })
    expect(listener).toHaveBeenCalledTimes(3)
    stop(); stop()
    await ctx.agentQueue.publish(root, { recipients: [local.id], body: 'after disposal' })
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('contains callback defects, filters unrelated addresses, and disposes on abort', async () => {
    const { ctx, root, foreign } = await setup()
    const logged = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.agentDirectQueue.observe(foreign, () => { throw new Error('observer defect') })
    const listener = vi.fn(); const controller = new AbortController()
    await ctx.agentDirectQueue.observe(root, listener, controller.signal)
    await expect(ctx.agentDirectQueue.send(root, { recipients: [foreign.id], body: 'committed' })).resolves.toMatchObject({ seq: 1 })
    expect(logged).toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled()
    await ctx.agentDirectQueue.send(foreign, { recipients: [root.id], body: 'reply' })
    expect(listener).toHaveBeenLastCalledWith({ workspaceId: homeId, seq: 2 })
    await ctx.agentDirectQueue.ackInbox(root, 2)
    expect(listener).toHaveBeenCalledTimes(2)
    controller.abort()
    await ctx.agentDirectQueue.send(foreign, { recipients: [root.id], body: 'after abort' })
    expect(listener).toHaveBeenCalledTimes(2)
    await expect(ctx.agentDirectQueue.observe(root, listener, controller.signal)).rejects.toThrow()
  })

  it.each(['local', 'direct'] as const)('contains asynchronous %s observer rejection without blocking later observers or queue work', async (channel) => {
    const { ctx, root, local, foreign } = await setup()
    const logged = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const rejected = new Error('asynchronous observer defect')
    const queue = channel === 'local' ? ctx.agentQueue : ctx.agentDirectQueue
    const target = channel === 'local' ? local : foreign
    await queue.observe(target, async () => { throw rejected })
    const acknowledged = Promise.withResolvers<undefined>()
    await queue.observe(target, async ({ seq }) => {
      if (channel === 'local') await ctx.agentQueue.ack(target, homeId, seq)
      else await ctx.agentDirectQueue.ackInbox(target, seq)
      acknowledged.resolve(undefined)
    })
    const later = vi.fn()
    await queue.observe(target, later)
    const send = channel === 'local'
      ? ctx.agentQueue.publish(root, { recipients: [target.id], body: 'committed despite observer failure' })
      : ctx.agentDirectQueue.send(root, { recipients: [target.id], body: 'committed despite observer failure' })
    await expect(send).resolves.toMatchObject({ seq: 1 })
    await acknowledged.promise
    expect(later).toHaveBeenCalled()
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('observation failed'), rejected)
  })

  it.each(['local', 'direct'] as const)('rejects %s observer registration when its queue unloads during authorization', async (channel) => {
    const { ctx, root, home, resolveByPath, localFiber, directFiber } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<typeof home>()
    resolveByPath.mockImplementationOnce(async () => { entered.resolve(undefined); return release.promise })
    const listener = vi.fn()
    const queue = channel === 'local' ? ctx.agentQueue : ctx.agentDirectQueue
    const registration = queue.observe(root, listener)
    const outcome = expect(registration).rejects.toThrow('observation owner is disposed')
    await entered.promise
    await (channel === 'local' ? localFiber : directFiber).dispose()
    release.resolve(home)
    await outcome
    await expect(queue.observe(root, listener)).rejects.toThrow('observation owner is disposed')
    expect(listener).not.toHaveBeenCalled()
  })

  it('installs both observers before initial frame and coalesces commits while suspended', async () => {
    const { ctx, root, local, foreign, remote } = await setup()
    const controller = new AbortController(); const stream = remote.watch(root.id, controller.signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toEqual({ done: false, value: { revision: 0 } })
    await expect(ctx.agentQueue.read(root)).rejects.toThrow('no addressed messages')
    for (let i = 0; i < 20; i++) {
      await ctx.agentQueue.publish(local, { recipients: [root.id], body: `local ${i}` })
      await ctx.agentDirectQueue.send(foreign, { recipients: [root.id], body: `direct ${i}` })
    }
    expect(await stream.next()).toEqual({ done: false, value: { revision: 1 } })
    const pending = stream.next(); controller.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
  })

  it('fails a waiting stream when its exact live Agent is disposed', async () => {
    const { ctx, root, remote, live } = await setup()
    const stream = remote.watch(root.id, new AbortController().signal)[Symbol.asyncIterator]()
    await stream.next()
    const pending = stream.next()
    live.delete(root.id)
    ctx.emit('agent/disposed', { agent: root })
    await expect(pending).rejects.toMatchObject({ code: 'agent-mail/address-changed' })
  })

  it('rejects an offline Session identity without creating or resuming an Agent', async () => {
    const { ctx, root, remote, live } = await setup()
    const created = vi.fn()
    const stop = ctx.on('agent/created', () => { created(); return undefined }, { global: true })
    live.delete(root.id)
    await expect(remote.watch(root.id, new AbortController().signal)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: 'agent-mail/address-changed', details: { sessionId: root.id } })
    expect(live.has(root.id)).toBe(false)
    expect(created).not.toHaveBeenCalled()
    stop()
  })

  it('invalidates eligible roster changes but rejects captured membership loss', async () => {
    const { ctx, root, foreign, remote, live, home } = await setup()
    const controller = new AbortController(); const stream = remote.watch(root.id, controller.signal)[Symbol.asyncIterator]()
    await stream.next()
    const changed = stream.next(); live.delete(foreign.id)
    ctx.emit('agent/disposed', { agent: foreign })
    expect(await changed).toEqual({ done: false, value: { revision: 1 } })
    const revoked = stream.next(); home.sessionIds = []
    await ctx.parallel('workspace/changed', { workspaceId: homeId })
    await expect(revoked).rejects.toMatchObject({ code: 'agent-mail/address-changed' })
  })

  it('does not notify failed writes or stale exact Agent observations', async () => {
    const { ctx, root, local, foreign, live, pool } = await setup()
    const localNotice = vi.fn(); const directNotice = vi.fn()
    await ctx.agentQueue.observe(local, localNotice)
    await ctx.agentDirectQueue.observe(foreign, directNotice)
    pool.failNextWrites = 1
    await expect(ctx.agentQueue.publish(root, { recipients: [local.id], body: 'failed' })).rejects.toThrow('injected write failure')
    pool.failNextWrites = 1
    await expect(ctx.agentDirectQueue.send(root, { recipients: [foreign.id], body: 'failed' })).rejects.toThrow('injected write failure')
    expect(localNotice).not.toHaveBeenCalled(); expect(directNotice).not.toHaveBeenCalled()
    live.set(local.id, { ...local })
    live.set(foreign.id, { ...foreign })
    await ctx.agentQueue.publish(root, { recipients: [local.id], body: 'new identity only' })
    await ctx.agentDirectQueue.send(root, { recipients: [foreign.id], body: 'new identity only' })
    expect(localNotice).not.toHaveBeenCalled(); expect(directNotice).not.toHaveBeenCalled()
  })

  it('rejects non-owner invocation on every mail method before queue work', async () => {
    const { ctx, root } = await setup()
    const signal = new AbortController().signal
    const invocation: RemoteInvocation = {
      request: { namespace: 'agentMail', method: 'watch', args: {} },
      service: 'agentMailRemote', signal,
      peer: { id: 'mail-guest' as PeerId, ctx, principal: { kind: 'mail-test-guest' }, interactions: 'answer', signal, dispose: async () => {} },
      uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
    }
    const borrowed = ctx.extend({ invocation })
    const scoped = borrowed.get('agentMailRemote') as AgentMailRemote
    await expect(scoped.address(root)).rejects.toMatchObject({ code: 'agent-mail/owner-required' })
    await expect(scoped.inbox(root, 'local')).rejects.toMatchObject({ code: 'agent-mail/owner-required' })
    await expect(scoped.send(root, 'local', [root.id], 'denied')).rejects.toMatchObject({ code: 'agent-mail/owner-required' })
    await expect(scoped.ack(root, 'local', 0)).rejects.toMatchObject({ code: 'agent-mail/owner-required' })
    await expect(scoped.watch(root.id, signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'agent-mail/owner-required' })
  })

  it('disposes waiting observations when the Remote owner unloads', async () => {
    const { ctx, root, remote } = await setup()
    const stream = remote.watch(root.id, new AbortController().signal)[Symbol.asyncIterator]()
    await stream.next(); const pending = stream.next()
    await ctx.fiber.dispose()
    expect(await pending).toEqual({ done: true, value: undefined })
  })
})
