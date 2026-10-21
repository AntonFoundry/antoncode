import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import AgentQueue, { MAX_WORKSPACE_MESSAGES } from '../src/index.ts'

const directory = '/queue/workspace'
const id = WorkspaceId('ws-one')
const members = [SessionId('root'), SessionId('alpha'), SessionId('beta')]
const workspace = { id, sessionIds: members, path: directory }

async function harness(pool = new MemoryMediaPool()) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const live = new Map<string, Agent>()
  const resolved = vi.fn(async (cwd: string) => cwd === directory ? workspace : undefined)
  ctx.provide('workspaceRegistry', { resolveByPath: resolved } as never)
  ctx.provide('agents', { get: (session: string) => live.get(session) } as never)
  const fiber = await ctx.plugin(AgentQueue)
  function agent(name: string, cwd = directory) {
    const session = SessionId(name)
    const value = { id: session, session: { header: { id: session, cwd } } } as Agent
    live.set(session, value)
    return value
  }
  return { ctx, fiber, queue: ctx.agentQueue, agent, live, pool, resolved }
}

const open = new Set<Awaited<ReturnType<typeof harness>>>()
afterEach(async () => { for (const item of open) await item.fiber.dispose(); open.clear() })
async function setup(pool?: MemoryMediaPool) { const h = await harness(pool); open.add(h); return h }

describe('durable agent queue', () => {
  it('requires exact live identity and validated workspace membership', async () => {
    const { queue, agent, live, resolved } = await setup()
    const root = agent('root')
    await queue.subscribe(root, id)
    expect(await queue.identities(root)).toEqual({ workspaceId: id, sessionId: root.id, sessionIds: members })
    await expect(queue.subscribe(root, WorkspaceId('elsewhere'))).rejects.toThrow('workspace')
    await expect(queue.publish(root, { workspaceId: WorkspaceId('elsewhere'), workspaceWide: true, body: 'no' })).rejects.toThrow('workspace')
    await expect(queue.read(root, { workspaceId: WorkspaceId('elsewhere') })).rejects.toThrow('workspace')
    await expect(queue.ack(root, WorkspaceId('elsewhere'), 0)).rejects.toThrow('workspace')
    expect(resolved).toHaveBeenCalledWith(directory)
    await expect(queue.publish({ ...root } as Agent, { workspaceWide: true, body: 'forged' })).rejects.toThrow('exact live')
    await expect(queue.subscribe(agent('stranger'))).rejects.toThrow('member')
    await expect(queue.publish(root, { recipients: [SessionId('stranger')], body: 'no' })).rejects.toThrow('recipient')
    await expect(queue.publish(root, { workspaceWide: true, body: 'ok' })).resolves.toMatchObject({ seq: 1 })
    live.delete(root.id)
    await expect(queue.read(root)).rejects.toThrow('exact live')
  })

  it('fans out direct and workspace messages only to subscribed recipients', async () => {
    const { queue, agent } = await setup()
    const root = agent('root'); const alpha = agent('alpha'); const beta = agent('beta')
    await Promise.all([queue.subscribe(root), queue.subscribe(alpha), queue.subscribe(beta)])
    const direct = await queue.publish(root, { recipients: [alpha.id, alpha.id, beta.id], body: 'private' })
    expect(direct.recipients).toEqual([alpha.id, beta.id])
    await queue.publish(beta, { workspaceWide: true, body: 'broadcast' })
    expect((await queue.read(root)).messages.map(x => x.body)).toEqual(['broadcast'])
    expect((await queue.read(alpha)).messages[1]?.recipients).toEqual([root.id, alpha.id, beta.id])
    expect((await queue.read(alpha)).messages.map(x => x.body)).toEqual(['private', 'broadcast'])
    expect((await queue.read(beta)).messages.map(x => x.body)).toEqual(['private', 'broadcast'])
    expect(await queue.ack(alpha, id, 1)).toBe(1)
    expect((await queue.read(alpha)).messages.map(x => x.seq)).toEqual([2])
    expect((await queue.read(beta)).messages.map(x => x.seq)).toEqual([1, 2])
    await queue.ack(root, id, 2)
    await queue.ack(beta, id, 2)
    expect((await queue.read(alpha, { cursor: 0 })).messages.map(x => x.seq)).toEqual([1, 2])
    expect((await queue.read(alpha, { workspaceId: id, cursor: 0, limit: 1 })).hasMore).toBe(true)
    await expect(queue.read(alpha, { cursor: 0, after: 1 })).rejects.toThrow('disagree')
    await expect(queue.read(alpha, { limit: 101 })).rejects.toThrow('limit')
    await expect(queue.ack(alpha, id, 3)).rejects.toThrow('head')
  })

  it('serializes concurrent publication and retains messages and cursors after reopening', async () => {
    const pool = new MemoryMediaPool()
    const h = await setup(pool)
    const root = h.agent('root'); const alpha = h.agent('alpha')
    await h.queue.subscribe(root); await h.queue.subscribe(alpha)
    const published = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      h.queue.publish(root, { recipients: [alpha.id], body: `item ${i}` })))
    expect(published.map(x => x.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    await h.queue.ack(alpha, id, 5)
    await h.fiber.dispose(); open.delete(h)
    const resumed = await setup(pool)
    const resumedAlpha = resumed.agent('alpha')
    expect((await resumed.queue.read(resumedAlpha)).messages.map(x => x.seq)).toEqual([6, 7, 8, 9, 10, 11, 12])
    expect((await resumed.queue.read(resumedAlpha, { after: 0, limit: 2 })).messages.map(x => x.seq)).toEqual([1, 2])
  })

  it('freezes workspace topic recipients and excludes future subscribers from earlier mail', async () => {
    const { queue, agent } = await setup()
    const root = agent('root'); const alpha = agent('alpha'); const beta = agent('beta')
    await queue.subscribe(root)
    await queue.subscribe(alpha)
    const first = await queue.publish(root, { recipients: [beta.id], workspaceWide: true, body: 'before' })
    expect(first.recipients).toEqual([beta.id, root.id, alpha.id])
    await queue.subscribe(beta)
    expect((await queue.read(beta)).messages.map(message => message.body)).toEqual(['before'])
    // A future subscriber not explicitly addressed must not inherit old topic traffic.
    const later = agent('later')
    members.push(later.id)
    try {
      await queue.subscribe(later)
      expect((await queue.read(later)).messages).toEqual([])
      expect((await queue.publish(root, { workspaceWide: true, body: 'after' })).recipients).toContain(later.id)
      expect((await queue.read(later)).messages.map(message => message.body)).toEqual(['after'])
    } finally { members.pop() }
  })

  it('delivers direct messages to a cold addressee without subscribing it to broadcasts', async () => {
    const { queue, agent } = await setup()
    const root = agent('root'); const cold = agent('alpha')
    await queue.subscribe(root)
    await expect(queue.read(cold)).rejects.toThrow('no addressed messages')
    const direct = await queue.publish(root, { recipients: [cold.id], body: 'cold direct' })
    expect((await queue.read(cold)).messages).toMatchObject([{ id: direct.id }])
    expect(await queue.ack(cold, id, direct.seq)).toBe(1)
    await queue.publish(root, { workspaceWide: true, body: 'topic before opt-in' })
    expect((await queue.read(cold, { cursor: 0 })).messages).toEqual([]) // fully acked direct mail was compacted
    await queue.subscribe(cold)
    await queue.publish(root, { workspaceWide: true, body: 'topic after opt-in' })
    expect((await queue.read(cold)).messages.map(message => message.body)).toEqual(['topic after opt-in'])
  })

  it('retains cold direct delivery and its cursor across a service restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await setup(pool)
    const sender = first.agent('root'); const cold = first.agent('alpha')
    await first.queue.publish(sender, { recipients: [cold.id], body: 'persisted cold' })
    await first.fiber.dispose(); open.delete(first)
    const second = await setup(pool)
    const restored = second.agent('alpha')
    expect((await second.queue.read(restored)).messages.map(message => message.body)).toEqual(['persisted cold'])
    await second.queue.ack(restored, id, 1)
    await second.queue.subscribe(restored)
    expect((await second.queue.read(restored)).cursor).toBe(1)
  })

  it('rejects an empty topic without advancing the durable stream', async () => {
    const { queue, agent } = await setup()
    const root = agent('root'); const alpha = agent('alpha')
    await expect(queue.publish(root, { workspaceWide: true, body: 'nobody' })).rejects.toThrow('no current subscribers')
    await queue.subscribe(alpha)
    const delivered = await queue.publish(root, { workspaceWide: true, body: 'now' })
    expect(delivered).toMatchObject({ seq: 1, recipients: [alpha.id] })
    expect((await queue.read(alpha)).messages.map(message => message.body)).toEqual(['now'])
  })

  it('bounds unread backlog without dropping it and compacts only after acknowledgment', async () => {
    const { queue, agent } = await setup()
    const root = agent('root'); const alpha = agent('alpha')
    await queue.subscribe(alpha)
    const message = await queue.publish(root, { recipients: [alpha.id], body: 'first' })
    // Fill the rest with durable addressed messages; no subscriber may silently lose one.
    for (let i = 1; i < MAX_WORKSPACE_MESSAGES; i++) {
      await queue.publish(root, { recipients: [alpha.id], body: 'pending' })
    }
    await expect(queue.publish(root, { recipients: [alpha.id], body: 'overflow' })).rejects.toThrow('backlog is full')
    expect((await queue.read(alpha, { cursor: 0, limit: 1 })).messages[0]?.id).toBe(message.id)
    await queue.ack(alpha, id, message.seq)
    expect((await queue.publish(root, { recipients: [alpha.id], body: 'now fits' })).seq).toBe(MAX_WORKSPACE_MESSAGES + 1)
    expect((await queue.read(alpha, { cursor: 0, limit: 1 })).messages[0]?.seq).toBe(2)
  })

  it('notifies after durable publication without waking or failing on callback errors', async () => {
    const { queue, agent } = await setup()
    const root = agent('root'); const alpha = agent('alpha')
    const notices: number[] = []
    await queue.subscribe(root)
    const dispose = await queue.subscribe(alpha, id, notice => notices.push(notice.seq))
    await queue.publish(root, { recipients: [alpha.id], body: 'first' })
    expect(notices).toEqual([1])
    dispose()
    await queue.publish(root, { recipients: [alpha.id], body: 'second' })
    expect(notices).toEqual([1])
    const replay = vi.fn(() => { throw Error('listener failure') })
    await queue.subscribe(alpha, id, replay)
    expect(replay).toHaveBeenCalledWith({ workspaceId: id, seq: 2 })
    await expect(queue.publish(root, { workspaceWide: true, body: 'third' })).resolves.toMatchObject({ seq: 3 })
    expect((await queue.read(alpha)).messages).toHaveLength(3)
    await expect(queue.unsubscribe(alpha)).rejects.toThrow('acknowledge unread')
    await queue.ack(alpha, id, 3)
    expect(await queue.unsubscribe(alpha)).toBe(true)
    expect((await queue.read(alpha)).messages).toEqual([])
  })
})
