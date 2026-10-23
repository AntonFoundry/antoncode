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
  DIRECT_RETENTION_MS, MAX_DIRECT_BODY_LENGTH, MAX_DIRECT_LEDGER_BYTES, MAX_DIRECT_MESSAGES,
  MAX_DIRECT_RECIPIENTS,
} from '../src/direct.ts'

const homeDirectory = '/direct/home'
const homeId = WorkspaceId('ws-home')
const homeMembers = [SessionId('root'), SessionId('alpha')]
const awayDirectory = '/direct/away'
const awayId = WorkspaceId('ws-away')
const awayMembers = [SessionId('away-root'), SessionId('away-offline')]
const thirdDirectory = '/direct/third'
const thirdId = WorkspaceId('ws-third')
const thirdMembers = [SessionId('third-root')]

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
  const third = { id: thirdId, sessionIds: thirdMembers, path: thirdDirectory }
  const resolveByPath = vi.fn(async (cwd: string) => cwd === homeDirectory
    ? { ...home }
    : cwd === awayDirectory ? { ...away } : cwd === thirdDirectory ? { ...third } : undefined)
  ctx.provide('workspaceRegistry', {
    resolveByPath, list: () => [{ ...home }, { ...away }, { ...third }],
  } as never)
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
  it('delivers to other workspaces: live peers, offline members, and subagents', async () => {
    const { queue, agent, subagent } = await setup()
    const sender = agent('root')
    const foreign = agent('away-root', awayDirectory)
    const foreignChild = subagent('away-child', foreign, awayDirectory)
    const third = agent('third-root', thirdDirectory)
    const offline = SessionId('away-offline')
    expect(await queue.address(sender)).toEqual({
      sessionId: sender.id, workspaceId: homeId, inboxCursor: 0, unread: 0,
    })
    const message = await queue.send(sender, {
      recipients: [foreign.id, foreignChild.id, offline, third.id, foreign.id],
      body: 'cross-workspace handoff',
    })
    expect(message).toMatchObject({ seq: 1, sender: sender.id, senderWorkspaceId: homeId })
    expect(message.recipients).toEqual([
      { sessionId: foreign.id, workspaceId: awayId },
      { sessionId: foreignChild.id, workspaceId: awayId },
      { sessionId: offline, workspaceId: awayId },
      { sessionId: third.id, workspaceId: thirdId },
    ])
    expect((await queue.inbox(foreign)).messages.map(entry => entry.body)).toEqual(['cross-workspace handoff'])
    expect((await queue.inbox(foreignChild)).messages.map(entry => entry.seq)).toEqual([1])
    expect((await queue.inbox(third)).messages.map(entry => entry.seq)).toEqual([1])
    expect(await queue.address(foreign)).toMatchObject({ workspaceId: awayId, inboxCursor: 0, unread: 1 })
    // The sender is not an addressee of its own message.
    expect((await queue.inbox(sender)).messages).toEqual([])
    const reply = await queue.send(foreign, { recipients: [sender.id], body: 'reply from away' })
    expect(reply).toMatchObject({ seq: 2, senderWorkspaceId: awayId })
    expect((await queue.inbox(sender)).messages.map(entry => entry.body)).toEqual(['reply from away'])
  })

  it('refuses same-workspace addressing and leaves local mail to the v1 queue', async () => {
    const { ctx, queue, agent, subagent } = await setup()
    const sender = agent('root')
    const localPeer = agent('alpha')
    const localChild = subagent('local-child', sender)
    const foreign = agent('away-root', awayDirectory)
    for (const recipients of [[localPeer.id], [localChild.id], [foreign.id, localPeer.id]]) {
      await expect(queue.send(sender, { recipients, body: 'local' }))
        .rejects.toThrow('cross-workspace mail only; use agent_queue_send')
    }
    // A rejected mixed send consumes no sequence and delivers to nobody.
    expect((await queue.inbox(foreign)).messages).toEqual([])
    expect((await queue.send(sender, { recipients: [foreign.id], body: 'remote' })).seq).toBe(1)
    // The same local pair still exchanges mail through the untouched v1 domain.
    const v1 = await ctx.plugin(AgentQueue)
    try {
      const local = await ctx.agentQueue.publish(sender, { recipients: [localPeer.id], body: 'v1 local direct' })
      expect(local).toMatchObject({ workspaceId: homeId, seq: 1 })
      expect((await ctx.agentQueue.read(localPeer)).messages.map(entry => entry.body)).toEqual(['v1 local direct'])
      // Neither ledger learned about the other: v1 keeps its own cursor and sequence.
      expect((await queue.inbox(localPeer)).messages).toEqual([])
      expect(await ctx.agentQueue.ack(localPeer, homeId, local.seq)).toBe(local.seq)
      expect((await queue.address(localPeer)).inboxCursor).toBe(0)
    } finally { await v1.dispose() }
  })

  it('rejects forged callers, unknown addressees, and oversized or empty sends', async () => {
    const { queue, agent, live } = await setup()
    const sender = agent('root')
    const foreign = agent('away-root', awayDirectory)
    await expect(queue.send({ ...sender } as Agent, { recipients: [foreign.id], body: 'forged' }))
      .rejects.toThrow('exact live')
    await expect(queue.address({ ...sender } as Agent)).rejects.toThrow('exact live')
    await expect(queue.inbox({ ...sender } as Agent)).rejects.toThrow('exact live')
    await expect(queue.ackInbox({ ...sender } as Agent, 0)).rejects.toThrow('exact live')
    const stranger = agent('stranger', '/direct/unregistered')
    await expect(queue.address(stranger)).rejects.toThrow('unregistered_working_directory')
    await expect(queue.send(stranger, { recipients: [foreign.id], body: 'no' }))
      .rejects.toThrow('unregistered_working_directory')
    await expect(queue.send(sender, { recipients: [SessionId('ghost')], body: 'no' }))
      .rejects.toThrow('does not belong to a registered workspace')
    await expect(queue.send(sender, { recipients: [], body: 'no' })).rejects.toThrow('at least one recipient')
    await expect(queue.send(sender, { recipients: undefined as never, body: 'no' }))
      .rejects.toThrow('invalid direct recipients')
    await expect(queue.send(sender, { recipients: ['' as SessionId], body: 'no' }))
      .rejects.toThrow('invalid direct recipient')
    await expect(queue.send(sender, {
      recipients: Array.from({ length: MAX_DIRECT_RECIPIENTS + 1 }, (_, index) => SessionId(`r-${index}`)),
      body: 'no',
    })).rejects.toThrow('too many recipients')
    await expect(queue.send(sender, { recipients: [foreign.id], body: '' })).rejects.toThrow()
    await expect(queue.send(sender, { recipients: [foreign.id], body: 'x'.repeat(65537) })).rejects.toThrow()
    await expect(queue.inbox(sender, { limit: 101 })).rejects.toThrow('limit')
    await expect(queue.inbox(sender, { cursor: -1 })).rejects.toThrow('nonnegative')
    await expect(queue.ackInbox(sender, -1)).rejects.toThrow('nonnegative')
    await expect(queue.ackInbox(sender, 0)).rejects.toThrow('no addressed messages')
    await queue.send(sender, { recipients: [foreign.id], body: 'delivered' })
    await expect(queue.ackInbox(foreign, 2)).rejects.toThrow('beyond committed')
    // A sender whose live identity disappears mid-flight cannot complete a send.
    const vanishing = agent('alpha')
    const inflight = queue.send(vanishing, { recipients: [foreign.id], body: 'vanishing' })
    live.delete(vanishing.id)
    await expect(inflight).rejects.toThrow('exact live')
  })

  it('reads and acknowledges through an explicit direct inbox cursor', async () => {
    const { queue, agent } = await setup()
    const sender = agent('root')
    const foreign = agent('away-root', awayDirectory)
    const third = agent('third-root', thirdDirectory)
    const first = await queue.send(sender, { recipients: [foreign.id, third.id], body: 'one' })
    const second = await queue.send(sender, { recipients: [foreign.id], body: 'two' })
    expect(await queue.inbox(foreign)).toMatchObject({ inboxCursor: 0, hasMore: false })
    expect(await queue.ackInbox(foreign, first.seq)).toBe(first.seq)
    // Acknowledgement is monotonic and per session: a lower value is a no-op,
    // and one addressee's cursor never moves another's.
    expect(await queue.ackInbox(foreign, 0)).toBe(first.seq)
    expect((await queue.inbox(foreign)).inboxCursor).toBe(first.seq)
    expect((await queue.inbox(foreign)).messages.map(entry => entry.seq)).toEqual([second.seq])
    expect(await queue.address(third)).toMatchObject({ inboxCursor: 0, unread: 1 })
    expect((await queue.inbox(third)).messages.map(entry => entry.seq)).toEqual([first.seq])
    // An explicit cursor replays retained mail without acknowledging anything.
    expect((await queue.inbox(foreign, { cursor: 0 })).messages.map(entry => entry.seq)).toEqual([1, 2])
    expect(await queue.inbox(foreign, { cursor: 0, limit: 1 }))
      .toMatchObject({ hasMore: true, inboxCursor: first.seq })
    await queue.ackInbox(third, first.seq)
    await queue.ackInbox(foreign, second.seq)
    // Mail acknowledged by every addressee is compacted, so replay stops.
    expect((await queue.inbox(foreign, { cursor: 0 })).messages).toEqual([])
    expect((await queue.inbox(third, { cursor: 0 })).messages).toEqual([])
    expect(await queue.address(foreign)).toMatchObject({ inboxCursor: second.seq, unread: 0 })
  })

  it('bounds the ledger by message count, encoded size, and a single writer', async () => {
    const { queue, agent } = await setup()
    const sender = agent('root')
    const foreign = agent('away-root', awayDirectory)
    // The count cap alone does not bound the record: 512 maximum bodies exceed
    // the encoded ceiling, so the byte bound is the binding one for large mail.
    expect(MAX_DIRECT_LEDGER_BYTES).toBeLessThan(MAX_DIRECT_MESSAGES * MAX_DIRECT_BODY_LENGTH)
    const first = await queue.send(sender, { recipients: [foreign.id], body: 'first' })
    for (let index = 1; index < MAX_DIRECT_MESSAGES; index++) {
      await queue.send(sender, { recipients: [foreign.id], body: `fill ${index}` })
    }
    await expect(queue.send(sender, { recipients: [foreign.id], body: 'overflow' }))
      .rejects.toThrow('backlog is full')
    // Nothing was dropped to make room: the oldest unread message is still first.
    expect((await queue.inbox(foreign, { cursor: 0, limit: 1 })).messages[0]?.id).toBe(first.id)
    await queue.ackInbox(foreign, first.seq)
    expect((await queue.send(sender, { recipients: [foreign.id], body: 'now fits' })).seq)
      .toBe(MAX_DIRECT_MESSAGES + 1)
    // commit() is the only writer: it refuses to run while another write is in flight.
    const service = queue as unknown as {
      writing: boolean
      commit(next: { nextSeq: number; messages: unknown[]; inboxes: unknown[] }): Promise<void>
    }
    service.writing = true
    try {
      await expect(service.commit({ nextSeq: 1, messages: [], inboxes: [] }))
        .rejects.toThrow('concurrent writer')
    } finally { service.writing = false }
    await expect(service.commit({
      nextSeq: 1, messages: [], inboxes: ['x'.repeat(MAX_DIRECT_LEDGER_BYTES)],
    })).rejects.toThrow('above the')
  })

  it('expires mail past the retention ceiling without consuming the backlog', async () => {
    const { queue, agent } = await setup()
    const sender = agent('root')
    const foreign = agent('away-root', awayDirectory)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const stale = await queue.send(sender, { recipients: [foreign.id], body: 'stale' })
      vi.setSystemTime(new Date(Date.now() + DIRECT_RETENTION_MS + 1))
      const fresh = await queue.send(sender, { recipients: [foreign.id], body: 'fresh' })
      expect((await queue.inbox(foreign)).messages.map(entry => entry.seq)).toEqual([fresh.seq])
      expect(fresh.seq).toBe(stale.seq + 1)
    } finally { vi.useRealTimers() }
  })

  it('serializes concurrent sends and reopens a medium that held only v1 mail', async () => {
    const pool = new MemoryMediaPool()
    const legacy = await setup(pool)
    // A store written by the v1 workspace queue must open as an empty direct ledger.
    const legacyFiber = await legacy.ctx.plugin(AgentQueue)
    const legacySender = legacy.agent('root')
    const legacyLocal = legacy.agent('alpha')
    const legacyForeign = legacy.agent('away-root', awayDirectory)
    await legacy.ctx.agentQueue.publish(legacySender, { recipients: [legacyLocal.id], body: 'v1 only' })
    expect((await legacy.queue.inbox(legacyLocal)).messages).toEqual([])
    const sent = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      legacy.queue.send(legacySender, { recipients: [legacyForeign.id], body: `item ${index}` })))
    expect(sent.map(message => message.seq)).toEqual([1, 2, 3, 4, 5, 6])
    await legacy.queue.ackInbox(legacyForeign, 3)
    // The v1 domain keeps its own sequence and messages, untouched by direct mail.
    expect((await legacy.ctx.agentQueue.read(legacyLocal)).messages.map(message => message.body)).toEqual(['v1 only'])
    await legacyFiber.dispose()
    await legacy.fiber.dispose(); open.delete(legacy)

    const resumed = await setup(pool)
    const foreign = resumed.agent('away-root', awayDirectory)
    const sender = resumed.agent('root')
    const local = resumed.agent('alpha')
    expect((await resumed.queue.inbox(foreign)).messages.map(message => message.seq)).toEqual([4, 5, 6])
    expect(await resumed.queue.address(foreign)).toEqual({
      sessionId: foreign.id, workspaceId: awayId, inboxCursor: 3, unread: 3,
    })
    expect((await resumed.queue.send(sender, { recipients: [foreign.id], body: 'after reopen' })).seq).toBe(7)
    const resumedFiber = await resumed.ctx.plugin(AgentQueue)
    expect((await resumed.ctx.agentQueue.read(local)).messages.map(message => message.body)).toEqual(['v1 only'])
    await resumedFiber.dispose()
  })

  it('refuses service operations before initialization completes', async () => {
    // A fresh root publishes the service without reaching Service.init, so no domain is open.
    const detached = new AgentDirectQueue(new Context())
    expect(() => detached['record']()).toThrow('not initialized')
    await expect(detached['commit']({ nextSeq: 1, messages: [], inboxes: [] })).rejects.toThrow('not initialized')
  })
})
