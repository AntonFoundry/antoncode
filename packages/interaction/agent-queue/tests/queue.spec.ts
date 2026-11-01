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
const otherDirectory = '/queue/other-workspace'
const otherId = WorkspaceId('ws-two')
const otherMembers = [SessionId('other-root'), SessionId('other-child')]
const otherWorkspace = { id: otherId, sessionIds: otherMembers, path: otherDirectory }

async function harness(pool = new MemoryMediaPool()) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const live = new Map<string, Agent>()
  const sessionStore = new Map<string, Agent['session']>()
  const resolved = vi.fn(async (cwd: string) =>
    cwd === directory ? { ...workspace } : cwd === otherDirectory ? { ...otherWorkspace } : undefined)
  ctx.provide('workspaceRegistry', { resolveByPath: resolved } as never)
  ctx.provide('agents', { get: (session: string) => live.get(session), list: () => [...live.values()] } as never)
  ctx.provide('sessions', { get: (session: string) => sessionStore.get(session) } as never)
  const fiber = await ctx.plugin(AgentQueue)
  function agent(name: string, cwd = directory) {
    const session = SessionId(name)
    const value = { id: session, session: { header: { id: session, cwd } } } as Agent
    live.set(session, value)
    sessionStore.set(session, value.session)
    return value
  }
  function subagent(name: string, parent: Agent, cwd = directory, origin: 'subagent' | undefined = 'subagent') {
    const session = SessionId(name)
    const header = { id: session, cwd, parentSession: parent.id, ...(origin ? { origin } : {}) }
    const value = { id: session, session: { header } } as Agent
    live.set(session, value)
    sessionStore.set(session, value.session)
    return value
  }
  return { ctx, fiber, queue: ctx.agentQueue, agent, subagent, live, sessionStore, pool, resolved }
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
    await expect(queue.publish({ ...root }, { workspaceWide: true, body: 'forged' })).rejects.toThrow('exact live')
    await expect(queue.subscribe(agent('stranger'))).rejects.toThrow('not a member of a registered workspace (reason: root_not_registered_member)')
    await expect(queue.publish(root, { recipients: [SessionId('stranger')], body: 'no' })).rejects.toThrow('recipient')
    await expect(queue.publish(root, { workspaceWide: true, body: 'ok' })).resolves.toMatchObject({ seq: 1 })
    live.delete(root.id)
    await expect(queue.read(root)).rejects.toThrow('exact live')
  })

  it('authorizes live subagent lineage across direct, read, ack, and topic operations', async () => {
    const { queue, agent, subagent, live } = await setup()
    const root = agent('root')
    await expect(queue.publish({ ...root }, { workspaceWide: true, body: 'forged' })).rejects.toThrow('exact live')
    const child = subagent('child', root)
    const grandchild = subagent('grandchild', child)
    const childIdentities = await queue.identities(child)
    expect(childIdentities).toMatchObject({ workspaceId: id, sessionId: child.id })
    expect(childIdentities.sessionIds).toEqual(expect.arrayContaining([child.id, grandchild.id]))
    expect((await queue.identities(root)).sessionIds).toEqual(expect.arrayContaining([child.id, grandchild.id]))
    const unrelated = subagent('unrelated-invalid', agent('unattached'))
    ;(unrelated.session as { header: unknown }).header = { ...unrelated.session.header, origin: undefined }
    expect((await queue.identities(root)).sessionIds).toEqual(expect.arrayContaining([child.id, grandchild.id]))
    expect((await queue.identities(root)).sessionIds).not.toContain(unrelated.id)
    await queue.subscribe(child)
    const direct = await queue.publish(child, { recipients: [grandchild.id], body: 'lineage' })
    await expect(queue.read(grandchild)).resolves.toMatchObject({ messages: [{ body: 'lineage' }] })
    await expect(queue.ack(grandchild, id, direct.seq)).resolves.toBe(direct.seq)
    await queue.subscribe(grandchild)
    const topic = await queue.publish(root, { workspaceWide: true, body: 'subagent topic' })
    expect(topic.recipients).toContain(grandchild.id)
    await expect(queue.read(grandchild)).resolves.toMatchObject({ messages: [{ body: 'subagent topic' }] })
    await expect(queue.ack(grandchild, id, topic.seq)).resolves.toBe(topic.seq)
    const unattached = agent('unattached')
    await expect(queue.identities(unattached)).rejects.toThrow('not a member of a registered workspace (reason: root_not_registered_member)')
    const wrongOrigin = subagent('wrong-origin', root, directory)
    ;(wrongOrigin.session as { header: unknown }).header = { ...wrongOrigin.session.header, origin: undefined }
    await expect(queue.identities(wrongOrigin)).rejects.toThrow('parent_without_subagent_origin')
    const foreign = agent('other-root', otherDirectory)
    const spoof = subagent('spoof-child', foreign, directory)
    await expect(queue.identities(spoof)).rejects.toThrow('not a member of a registered workspace (reason: workspace_lineage_mismatch)')
    const missingParent = subagent('missing-parent', root)
    live.delete(root.id)
    await expect(queue.identities(missingParent)).rejects.toThrow('not a member of a registered workspace (reason: parent_not_live)')
    live.delete(child.id)
  })

  it('rejects cross-workspace addressing, mismatched scopes, and spoofed membership', async () => {
    const { queue, agent } = await setup()
    const sender = agent('root'); const peer = agent('alpha')
    const foreign = agent('other-root', otherDirectory)
    const foreignChild = agent('other-child', otherDirectory)
    await queue.subscribe(sender, id)
    await queue.subscribe(foreign, otherId)
    expect(await queue.identities(foreign)).toEqual({
      workspaceId: otherId, sessionId: foreign.id, sessionIds: otherMembers,
    })
    await expect(queue.publish(sender, { recipients: [foreign.id], body: 'escape' })).rejects.toThrow('recipient')
    await expect(queue.publish(foreign, { recipients: [peer.id], body: 'escape' })).rejects.toThrow('recipient')
    await expect(queue.publish(foreign, { workspaceId: id, workspaceWide: true, body: 'escape' })).rejects.toThrow('workspace')
    await expect(queue.read(foreign, { workspaceId: id })).rejects.toThrow('workspace')
    await expect(queue.ack(foreign, id, 0)).rejects.toThrow('workspace')
    await expect(queue.subscribe(foreign, id)).rejects.toThrow('workspace')
    // A valid session id cannot be used with an unrelated header cwd.
    const spoofed = agent('alpha', otherDirectory)
    await expect(queue.identities(spoofed)).rejects.toThrow('member')
    agent('alpha') // Reestablish a valid live identity for this durable address.
    const delivered = await queue.publish(sender, { recipients: [peer.id], body: 'local' })
    expect(delivered).toMatchObject({ workspaceId: id, seq: 1 })
    expect((await queue.read(foreign)).messages).toEqual([])
    expect((await queue.publish(foreign, { recipients: [foreignChild.id], body: 'foreign local' })).seq).toBe(1)
    expect((await queue.read(foreignChild)).messages.map(message => message.body)).toEqual(['foreign local'])
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
    const resumedSender = resumed.agent('root')
    expect((await resumed.queue.publish(resumedSender, { recipients: [resumedAlpha.id], body: 'post-restart' })).seq).toBe(13)
    expect((await resumed.queue.read(resumedAlpha)).messages.at(-1)?.body).toBe('post-restart')
  })

  it('serializes concurrent direct, subscribe, and topic operations by committed order', async () => {
    const { queue, agent } = await setup()
    const sender = agent('root'); const peer = agent('alpha'); const future = agent('beta')
    await queue.subscribe(sender)
    const first = queue.publish(sender, { recipients: [peer.id], body: 'direct' })
    const optIn = queue.subscribe(peer)
    const second = queue.publish(sender, { workspaceWide: true, body: 'topic' })
    const [direct, , topic] = await Promise.all([first, optIn, second])
    expect([direct.seq, topic.seq]).toEqual([1, 2])
    expect(topic.recipients).toEqual([sender.id, peer.id])
    expect((await queue.read(peer)).messages.map(message => message.body)).toEqual(['direct', 'topic'])
    await queue.subscribe(future)
    expect((await queue.read(future, { cursor: 0 })).messages).toEqual([])
    expect((await queue.publish(sender, { workspaceWide: true, body: 'later' })).seq).toBe(3)
    expect((await queue.read(future)).messages.map(message => message.body)).toEqual(['later'])
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

  it('keeps direct history when a cold recipient subscribes after an earlier broadcast', async () => {
    const { queue, agent } = await setup()
    const sender = agent('root'); const cold = agent('alpha')
    await queue.subscribe(sender)
    await queue.publish(sender, { workspaceWide: true, body: 'before direct' })
    const direct = await queue.publish(sender, { recipients: [cold.id], body: 'addressed before subscribe' })
    await queue.publish(sender, { workspaceWide: true, body: 'between direct and subscribe' })
    await queue.subscribe(cold)
    expect((await queue.read(cold)).messages.map(message => message.body)).toEqual(['addressed before subscribe'])
    expect((await queue.read(cold)).messages[0]?.seq).toBe(direct.seq)
    await queue.publish(sender, { workspaceWide: true, body: 'after subscribe' })
    expect((await queue.read(cold)).messages.map(message => message.body))
      .toEqual(['addressed before subscribe', 'after subscribe'])
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

  it('reads and acknowledges new direct mail after topic unsubscribe and restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await setup(pool)
    const sender = first.agent('root'); const recipient = first.agent('alpha')
    await first.queue.subscribe(sender)
    await first.queue.subscribe(recipient)
    expect(await first.queue.unsubscribe(recipient)).toBe(true)
    const direct = await first.queue.publish(sender, { recipients: [recipient.id], body: 'after unsubscribe' })
    expect((await first.queue.read(recipient)).messages.map(message => message.body)).toEqual(['after unsubscribe'])
    await first.fiber.dispose(); open.delete(first)
    const resumed = await setup(pool)
    const restoredSender = resumed.agent('root'); const restoredRecipient = resumed.agent('alpha')
    expect((await resumed.queue.read(restoredRecipient)).messages.map(message => message.seq)).toEqual([direct.seq])
    expect(await resumed.queue.ack(restoredRecipient, id, direct.seq)).toBe(direct.seq)
    expect((await resumed.queue.read(restoredRecipient)).messages).toEqual([])
    expect(await resumed.queue.unsubscribe(restoredRecipient)).toBe(false)
    await resumed.queue.publish(restoredSender, { workspaceWide: true, body: 'still unsubscribed' })
    expect((await resumed.queue.read(restoredRecipient, { cursor: 0 })).messages).toEqual([])
    const nextDirect = await resumed.queue.publish(restoredSender, { recipients: [restoredRecipient.id], body: 'direct again' })
    expect((await resumed.queue.read(restoredRecipient)).messages.map(message => message.body)).toEqual(['direct again'])
    expect(await resumed.queue.ack(restoredRecipient, id, nextDirect.seq)).toBe(nextDirect.seq)
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
