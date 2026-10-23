import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import AgentQueue from '../src/index.ts'
import AgentDirectQueue, {
  DIRECT_RETENTION_MS, MAX_DIRECT_MESSAGES, MAX_DIRECT_RECIPIENTS,
} from '../src/direct.ts'

const homeDirectory = '/direct/home'
const homeId = WorkspaceId('ws-home')
const homeMembers = [SessionId('root'), SessionId('alpha')]
const awayDirectory = '/direct/away'
const awayId = WorkspaceId('ws-away')
const awayMembers = [SessionId('away-root'), SessionId('away-offline')]

async function harness(pool = new MemoryMediaPool()) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const live = new Map<string, Agent>()
  const home = { id: homeId, sessionIds: homeMembers, path: homeDirectory }
  const away = { id: awayId, sessionIds: awayMembers, path: awayDirectory }
  const resolveByPath = vi.fn(async (cwd: string) =>
    cwd === homeDirectory ? { ...home } : cwd === awayDirectory ? { ...away } : undefined)
  ctx.provide('workspaceRegistry', { resolveByPath, list: () => [{ ...home }, { ...away }] } as never)
  ctx.provide('agents', { get: (id: string) => live.get(id), list: () => [...live.values()] } as never)
  const fiber = await ctx.plugin(AgentDirectQueue)
  const agent = (name: string, cwd = homeDirectory): Agent => {
    const id = SessionId(name)
    const value = { id, session: { header: { id, cwd } } } as Agent
    live.set(id, value)
    return value
  }
  const subagent = (name: string, parent: Agent, cwd = homeDirectory): Agent => {
    const id = SessionId(name)
    const value = { id, session: { header: { id, cwd, parentSession: parent.id, origin: 'subagent' } } } as Agent
    live.set(id, value)
    return value
  }
  return { ctx, fiber, queue: ctx.agentDirectQueue, agent, subagent, live, pool, resolveByPath }
}

const open = new Set<Awaited<ReturnType<typeof harness>>>()
afterEach(async () => { for (const item of open) await item.fiber.dispose(); open.clear() })
async function setup(pool?: MemoryMediaPool) { const h = await harness(pool); open.add(h); return h }

describe('cross-workspace direct mailbox', () => {
  it('delivers across workspaces to live peers, offline members, and subagents', async () => {
    const { queue, agent, subagent } = await setup()
    const sender = agent('root')
    const peer = agent('alpha')
    const foreign = agent('away-root', awayDirectory)
    const foreignChild = subagent('away-child', foreign, awayDirectory)
    const offline = SessionId('away-offline')
    expect(await queue.address(sender)).toEqual({
      sessionId: sender.id, workspaceId: homeId, cursor: 0, unread: 0,
    })
    const message = await queue.send(sender, {
      recipients: [peer.id, foreign.id, foreignChild.id, offline, peer.id],
      body: 'cross-workspace handoff',
    })
    expect(message).toMatchObject({ seq: 1, sender: sender.id, senderWorkspaceId: homeId })
    expect(message.recipients).toEqual([
      { sessionId: peer.id, workspaceId: homeId },
      { sessionId: foreign.id, workspaceId: awayId },
      { sessionId: foreignChild.id, workspaceId: awayId },
      { sessionId: offline, workspaceId: awayId },
    ])
    expect((await queue.inbox(foreign)).messages.map(entry => entry.body)).toEqual(['cross-workspace handoff'])
    expect((await queue.inbox(foreignChild)).messages.map(entry => entry.seq)).toEqual([1])
    expect((await queue.inbox(peer)).messages).toHaveLength(1)
    expect(await queue.address(foreign)).toMatchObject({ workspaceId: awayId, cursor: 0, unread: 1 })
    // The sender is not an addressee of its own message.
    expect((await queue.inbox(sender)).messages).toEqual([])
    const reply = await queue.send(foreign, { recipients: [sender.id], body: 'reply from away' })
    expect(reply).toMatchObject({ seq: 2, senderWorkspaceId: awayId })
    expect((await queue.inbox(sender)).messages.map(entry => entry.body)).toEqual(['reply from away'])
  })

  it('rejects forged callers, unknown addressees, and oversized or empty sends', async () => {
    const { queue, agent, live } = await setup()
    const sender = agent('root')
    const peer = agent('alpha')
    await expect(queue.send({ ...sender } as Agent, { recipients: [peer.id], body: 'forged' }))
      .rejects.toThrow('exact live')
    await expect(queue.address({ ...sender } as Agent)).rejects.toThrow('exact live')
    await expect(queue.inbox({ ...sender } as Agent)).rejects.toThrow('exact live')
    await expect(queue.ackInbox({ ...sender } as Agent, 0)).rejects.toThrow('exact live')
    const stranger = agent('stranger', '/direct/unregistered')
    await expect(queue.address(stranger)).rejects.toThrow('unregistered_working_directory')
    await expect(queue.send(stranger, { recipients: [peer.id], body: 'no' })).rejects.toThrow('unregistered_working_directory')
    await expect(queue.send(sender, { recipients: [SessionId('ghost')], body: 'no' }))
      .rejects.toThrow('does not belong to a registered workspace')
    await expect(queue.send(sender, { recipients: [], body: 'no' })).rejects.toThrow('at least one recipient')
    await expect(queue.send(sender, { recipients: undefined as never, body: 'no' })).rejects.toThrow('invalid direct recipients')
    await expect(queue.send(sender, { recipients: ['' as SessionId], body: 'no' })).rejects.toThrow('invalid direct recipient')
    await expect(queue.send(sender, {
      recipients: Array.from({ length: MAX_DIRECT_RECIPIENTS + 1 }, (_, index) => SessionId(`r-${index}`)),
      body: 'no',
    })).rejects.toThrow('too many recipients')
    await expect(queue.send(sender, { recipients: [peer.id], body: '' })).rejects.toThrow()
    await expect(queue.send(sender, { recipients: [peer.id], body: 'x'.repeat(65537) })).rejects.toThrow()
    await expect(queue.inbox(sender, { limit: 101 })).rejects.toThrow('limit')
    await expect(queue.inbox(sender, { cursor: -1 })).rejects.toThrow('nonnegative')
    await expect(queue.ackInbox(sender, -1)).rejects.toThrow('nonnegative')
    await expect(queue.ackInbox(sender, 0)).rejects.toThrow('no addressed messages')
    await queue.send(sender, { recipients: [peer.id], body: 'delivered' })
    await expect(queue.ackInbox(peer, 2)).rejects.toThrow('beyond committed')
    // A sender whose live identity disappears mid-flight cannot complete a send.
    const vanishing = agent('alpha')
    const inflight = queue.send(vanishing, { recipients: [sender.id], body: 'vanishing' })
    live.delete(vanishing.id)
    await expect(inflight).rejects.toThrow('exact live')
  })

  it('acknowledges monotonically, compacts fully read mail, and bounds the backlog', async () => {
    const { queue, agent } = await setup()
    const sender = agent('root')
    const peer = agent('alpha')
    const first = await queue.send(sender, { recipients: [peer.id], body: 'one' })
    const second = await queue.send(sender, { recipients: [peer.id], body: 'two' })
    expect(await queue.ackInbox(peer, first.seq)).toBe(first.seq)
    expect(await queue.ackInbox(peer, 0)).toBe(first.seq)
    expect((await queue.inbox(peer)).messages.map(entry => entry.seq)).toEqual([second.seq])
    expect((await queue.inbox(peer, { cursor: 0 })).messages.map(entry => entry.seq)).toEqual([2])
    expect(await queue.ackInbox(peer, second.seq)).toBe(second.seq)
    // Mail acknowledged by every addressee is compacted, so replay stops.
    expect((await queue.inbox(peer, { cursor: 0 })).messages).toEqual([])
    expect((await queue.inbox(peer)).cursor).toBe(second.seq)
    for (let index = 0; index < MAX_DIRECT_MESSAGES; index++) {
      await queue.send(sender, { recipients: [peer.id], body: `fill ${index}` })
    }
    await expect(queue.send(sender, { recipients: [peer.id], body: 'overflow' }))
      .rejects.toThrow('backlog is full')
    const page = await queue.inbox(peer, { limit: 1 })
    expect(page.hasMore).toBe(true)
    expect(page.messages.map(entry => entry.body)).toEqual(['fill 0'])
    await queue.ackInbox(peer, page.messages[0]!.seq)
    expect((await queue.send(sender, { recipients: [peer.id], body: 'now fits' })).seq)
      .toBe(MAX_DIRECT_MESSAGES + 3)
  })

  it('expires mail past the retention ceiling without consuming the backlog', async () => {
    const { queue, agent } = await setup()
    const sender = agent('root')
    const peer = agent('alpha')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const stale = await queue.send(sender, { recipients: [peer.id], body: 'stale' })
      vi.setSystemTime(new Date(Date.now() + DIRECT_RETENTION_MS + 1))
      const fresh = await queue.send(sender, { recipients: [peer.id], body: 'fresh' })
      expect((await queue.inbox(peer)).messages.map(entry => entry.seq)).toEqual([fresh.seq])
      expect(fresh.seq).toBe(stale.seq + 1)
    } finally { vi.useRealTimers() }
  })

  it('serializes concurrent sends and survives reopening a medium that held only v1 mail', async () => {
    const pool = new MemoryMediaPool()
    const legacy = await setup(pool)
    // A store written by the v1 workspace queue must open as an empty direct mailbox.
    const legacyFiber = await legacy.ctx.plugin(AgentQueue)
    const legacySender = legacy.agent('root')
    const legacyPeer = legacy.agent('alpha')
    await legacy.ctx.agentQueue.publish(legacySender, { recipients: [legacyPeer.id], body: 'v1 only' })
    expect((await legacy.queue.inbox(legacyPeer)).messages).toEqual([])
    const sent = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      legacy.queue.send(legacySender, { recipients: [legacyPeer.id], body: `item ${index}` })))
    expect(sent.map(message => message.seq)).toEqual([1, 2, 3, 4, 5, 6])
    await legacy.queue.ackInbox(legacyPeer, 3)
    // The v1 domain keeps its own sequence and messages, untouched by direct mail.
    expect((await legacy.ctx.agentQueue.read(legacyPeer)).messages.map(message => message.body)).toEqual(['v1 only'])
    await legacyFiber.dispose()
    await legacy.fiber.dispose(); open.delete(legacy)

    const resumed = await setup(pool)
    const peer = resumed.agent('alpha')
    const sender = resumed.agent('root')
    expect((await resumed.queue.inbox(peer)).messages.map(message => message.seq)).toEqual([4, 5, 6])
    expect(await resumed.queue.address(peer)).toEqual({
      sessionId: peer.id, workspaceId: homeId, cursor: 3, unread: 3,
    })
    expect((await resumed.queue.send(sender, { recipients: [peer.id], body: 'after reopen' })).seq).toBe(7)
    const resumedFiber = await resumed.ctx.plugin(AgentQueue)
    expect((await resumed.ctx.agentQueue.read(peer)).messages.map(message => message.body)).toEqual(['v1 only'])
    await resumedFiber.dispose()
  })

  it('refuses service operations before initialization completes', async () => {
    // A fresh root publishes the service without reaching Service.init, so no domain is open.
    const detached = new AgentDirectQueue(new Context())
    expect(() => detached['record']()).toThrow('not initialized')
    await expect(detached['commit']({ nextSeq: 1, messages: [], inboxes: [] })).rejects.toThrow('not initialized')
  })
})
