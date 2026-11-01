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
  MAX_DIRECT_BODY_LENGTH, MAX_DIRECT_INBOXES, MAX_DIRECT_LEDGER_BYTES, MAX_DIRECT_MESSAGES,
  DEFAULT_DIRECT_PEER_PAGE, MAX_DIRECT_PEER_PAGE, MAX_DIRECT_RECIPIENTS,
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
  it('delivers to live agents and live subagents in other workspaces only', async () => {
    const { queue, agent, subagent, live } = await setup()
    const sender = agent('root')
    const foreign = agent('away-root', awayDirectory)
    const foreignChild = subagent('away-child', foreign, awayDirectory)
    const third = agent('third-root', thirdDirectory)
    expect(await queue.address(sender)).toMatchObject({
      sessionId: sender.id, workspaceId: homeId, inboxCursor: 0, unread: 0,
    })
    // A registered but offline member is not addressable: its durable
    // membership can outlive the permissions its live lineage would prove.
    const offline = SessionId('away-offline')
    expect(awayMembers).toContain(offline)
    expect(live.get(offline)).toBeUndefined()
    await expect(queue.send(sender, { recipients: [foreign.id, offline], body: 'half offline' }))
      .rejects.toThrow('must be a live agent authorized in a registered workspace')
    const message = await queue.send(sender, {
      recipients: [foreign.id, foreignChild.id, third.id, foreign.id],
      body: 'cross-workspace handoff',
    })
    expect(message).toMatchObject({ seq: 1, sender: sender.id, senderWorkspaceId: homeId })
    expect(message.recipients).toEqual([
      { sessionId: foreign.id, workspaceId: awayId },
      { sessionId: foreignChild.id, workspaceId: awayId },
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

  it('discovers every live peer across workspaces with its transport', async () => {
    const { queue, agent, subagent, live } = await setup()
    const root = agent('root')
    const localPeer = agent('alpha')
    const localChild = subagent('local-child', root)
    const foreign = agent('away-root', awayDirectory)
    const foreignChild = subagent('away-child', foreign, awayDirectory)
    const third = agent('third-root', thirdDirectory)
    const identity = await queue.address(root)
    expect(identity).toMatchObject({ sessionId: root.id, workspaceId: homeId, hasMorePeers: false })
    expect(identity.nextPeerCursor).toBeUndefined()
    // Siblings, children, and other workspaces' roots are all discoverable,
    // each with the transport that actually reaches it; self is never a peer.
    // Deterministic order: workspace id, then session id.
    expect(identity.peers).toEqual([
      { sessionId: foreignChild.id, workspaceId: awayId, transport: 'direct' },
      { sessionId: foreign.id, workspaceId: awayId, transport: 'direct' },
      { sessionId: localPeer.id, workspaceId: homeId, transport: 'workspace-queue' },
      { sessionId: localChild.id, workspaceId: homeId, transport: 'workspace-queue' },
      { sessionId: third.id, workspaceId: thirdId, transport: 'direct' },
    ])
    // Discovery is symmetric: the same peer sees this caller as 'direct'.
    expect((await queue.address(foreign)).peers)
      .toContainEqual({ sessionId: root.id, workspaceId: homeId, transport: 'direct' })
    // Only live registry identities are listed: an offline member, a live
    // session in an unregistered directory, and a broken lineage are invisible.
    expect(awayMembers).toContain(SessionId('away-offline'))
    agent('drifter', '/direct/unregistered')
    const orphan = subagent('orphan', third, thirdDirectory)
    live.delete(third.id)
    const listed = (await queue.address(root)).peers.map(peer => peer.sessionId)
    expect(listed).not.toContain(SessionId('away-offline'))
    expect(listed).not.toContain(SessionId('drifter'))
    expect(listed).not.toContain(orphan.id)
    expect(listed).not.toContain(root.id)
    // Only session id and authorized workspace id are exposed.
    for (const peer of (await queue.address(root)).peers) {
      expect(Object.keys(peer).sort()).toEqual(['sessionId', 'transport', 'workspaceId'])
    }
  })

  it('skips a forged registry entry without hiding the peers beside it', async () => {
    const { queue, agent, live } = await setup()
    const root = agent('root')
    const honest = agent('away-root', awayDirectory)
    // A registry entry whose header claims another session is not the exact
    // live agent it claims to be. Discovery drops it and keeps enumerating,
    // so one poisoned entry cannot blind a caller to every real peer.
    const impostor = SessionId('impostor')
    live.set(impostor, {
      id: impostor, session: { header: { id: SessionId('away-root'), cwd: awayDirectory } },
    } as Agent)
    const identity = await queue.address(root)
    expect(identity.peers).toEqual([
      { sessionId: honest.id, workspaceId: awayId, transport: 'direct' },
    ])
    // Forgery remains unaddressable, and a forged CALLER is still rejected outright.
    await expect(queue.send(root, { recipients: [impostor], body: 'no' }))
      .rejects.toThrow('exact live')
    await expect(queue.address({ ...root })).rejects.toThrow('exact live')
  })

  it('pages peers by keyset so a caller walks past the one-page bound to every peer', async () => {
    const { queue, agent } = await setup()
    const root = agent('root')
    // More live peers than a single page can carry, spread across two
    // workspaces, so the walk must cross a workspace boundary as well.
    const total = MAX_DIRECT_PEER_PAGE + 37
    for (let index = 0; index < total; index++) {
      const name = `peer-${String(index).padStart(4, '0')}`
      const away = index % 3 === 0
      if (away) { awayMembers.push(SessionId(name)); agent(name, awayDirectory) } else {
        homeMembers.push(SessionId(name)); agent(name)
      }
    }
    try {
      const first = await queue.address(root, { peerLimit: MAX_DIRECT_PEER_PAGE })
      expect(first.peers).toHaveLength(MAX_DIRECT_PEER_PAGE)
      expect(first.hasMorePeers).toBe(true)
      expect(typeof first.nextPeerCursor).toBe('string')
      // Walk the cursor to exhaustion: every live peer is reachable, exactly
      // once, in one stable (workspaceId, sessionId) order — the old hard cap
      // would have hidden everything past the first page.
      const walked: { sessionId: string; workspaceId: string; transport: string }[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await queue.address(root, {
          peerLimit: 40, ...(cursor === undefined ? {} : { peerCursor: cursor }),
        })
        expect(page.peers.length).toBeLessThanOrEqual(40)
        walked.push(...page.peers.map(peer => ({ ...peer })))
        cursor = page.nextPeerCursor
        expect(page.hasMorePeers).toBe(cursor !== undefined)
        pages++
      } while (cursor !== undefined && pages < 20)
      expect(cursor).toBeUndefined()
      expect(walked).toHaveLength(total)
      expect(new Set(walked.map(peer => peer.sessionId)).size).toBe(total)
      expect(walked.map(peer => peer.sessionId)).not.toContain(root.id)
      const keys = walked.map(peer => `${peer.workspaceId}\u0000${peer.sessionId}`)
      expect(keys).toEqual([...keys].sort())
      // Local versus cross-workspace transport survives paging unchanged.
      for (const peer of walked) {
        expect(peer.transport).toBe(peer.workspaceId === homeId ? 'workspace-queue' : 'direct')
      }
      expect(new Set(walked.map(peer => peer.transport))).toEqual(new Set(['workspace-queue', 'direct']))
      // The first page is a prefix of the same walk, never a different order.
      expect(walked.slice(0, MAX_DIRECT_PEER_PAGE).map(peer => peer.sessionId))
        .toEqual(first.peers.map(peer => peer.sessionId))
      // A default page is bounded without a limit, and still continues.
      const byDefault = await queue.address(root)
      expect(byDefault.peers).toHaveLength(DEFAULT_DIRECT_PEER_PAGE)
      expect(byDefault.hasMorePeers).toBe(true)
    } finally { homeMembers.splice(2); awayMembers.splice(2) }
  })

  it('rejects a peer cursor it did not issue and a peer limit outside the page bound', async () => {
    const { queue, agent } = await setup()
    const root = agent('root')
    const away = agent('away-root', awayDirectory)
    for (const peerCursor of [
      '', '   ', 'not base64url!!', Buffer.from('null', 'utf8').toString('base64url'),
      Buffer.from('["only-one"]', 'utf8').toString('base64url'),
      Buffer.from('["ws","a","b"]', 'utf8').toString('base64url'),
      Buffer.from('["ws",""]', 'utf8').toString('base64url'),
      Buffer.from('["ws",7]', 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ workspaceId: awayId, sessionId: away.id }), 'utf8').toString('base64url'),
      'a'.repeat(5000),
    ]) {
      await expect(queue.address(root, { peerCursor })).rejects.toThrow(
        'direct peer cursor must be a token returned by a previous discovery page')
    }
    for (const peerLimit of [0, -1, 1.5, Number.NaN, MAX_DIRECT_PEER_PAGE + 1]) {
      await expect(queue.address(root, { peerLimit })).rejects.toThrow(
        `direct peer limit must be an integer between 1 and ${MAX_DIRECT_PEER_PAGE}`)
    }
    // A cursor positioned after the last peer ends the walk instead of failing.
    const page = await queue.address(root, { peerLimit: 1 })
    expect(page.peers.map(peer => peer.sessionId)).toEqual([away.id])
    expect(page.hasMorePeers).toBe(false)
    expect(page.nextPeerCursor).toBeUndefined()
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
    await expect(queue.send({ ...sender }, { recipients: [foreign.id], body: 'forged' }))
      .rejects.toThrow('exact live')
    await expect(queue.address({ ...sender })).rejects.toThrow('exact live')
    await expect(queue.inbox({ ...sender })).rejects.toThrow('exact live')
    await expect(queue.ackInbox({ ...sender }, 0)).rejects.toThrow('exact live')
    const stranger = agent('stranger', '/direct/unregistered')
    await expect(queue.address(stranger)).rejects.toThrow('unregistered_working_directory')
    await expect(queue.send(stranger, { recipients: [foreign.id], body: 'no' }))
      .rejects.toThrow('unregistered_working_directory')
    await expect(queue.send(sender, { recipients: [SessionId('ghost')], body: 'no' }))
      .rejects.toThrow('must be a live agent authorized in a registered workspace')
    // A live agent whose own lineage is unauthorized is equally unaddressable.
    const unregistered = agent('drifter', '/direct/unregistered')
    await expect(queue.send(sender, { recipients: [unregistered.id], body: 'no' }))
      .rejects.toThrow('must be a live agent authorized in a registered workspace')
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
    // The second message was addressed to the other workspace only, so this
    // addressee cannot acknowledge past the mail it can actually read.
    await expect(queue.ackInbox(third, second.seq))
      .rejects.toThrow('readable in your current workspace')
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

  it('authorizes each read against the current workspace and the frozen address', async () => {
    const { queue, agent, live } = await setup()
    const sender = agent('root')
    const mover = agent('away-root', awayDirectory)
    const message = await queue.send(sender, { recipients: [mover.id], body: 'addressed in ws-away' })
    expect((await queue.inbox(mover)).messages.map(entry => entry.body)).toEqual(['addressed in ws-away'])
    // The same durable session id reappears as a member of a third workspace.
    // Its direct mail was addressed to (session, ws-away) and must not follow it.
    thirdMembers.push(mover.id)
    live.delete(mover.id)
    const moved = agent('away-root', thirdDirectory)
    try {
      expect(await queue.address(moved)).toMatchObject({ workspaceId: thirdId, inboxCursor: 0, unread: 0 })
      expect((await queue.inbox(moved)).messages).toEqual([])
      expect((await queue.inbox(moved, { cursor: 0 })).messages).toEqual([])
      // It cannot retire that mail either: at this address it holds no inbox at all.
      await expect(queue.ackInbox(moved, message.seq))
        .rejects.toThrow('no addressed messages to acknowledge')
      // New mail is addressed to its CURRENT workspace and reaches it there.
      const here = await queue.send(sender, { recipients: [moved.id], body: 'to ws-third' })
      expect(here.seq).toBe(2)
      expect((await queue.inbox(moved)).messages.map(entry => entry.body)).toEqual(['to ws-third'])
      // Acknowledging at the new address must not move the old address's cursor.
      expect(await queue.ackInbox(moved, here.seq)).toBe(here.seq)
      expect(await queue.address(moved)).toMatchObject({ inboxCursor: here.seq, unread: 0 })
    } finally { thirdMembers.pop() }
    live.delete(moved.id)
    const returned = agent('away-root', awayDirectory)
    // The cursor is keyed by the frozen address pair, so the higher sequence
    // acknowledged in ws-third cannot hide this older unacknowledged message.
    expect(await queue.address(returned)).toMatchObject({ workspaceId: awayId, inboxCursor: 0, unread: 1 })
    expect((await queue.inbox(returned)).messages.map(entry => entry.seq)).toEqual([message.seq])
    expect(await queue.ackInbox(returned, message.seq)).toBe(message.seq)
    expect((await queue.inbox(returned, { cursor: 0 })).messages).toEqual([])
  })

  it('keeps one cursor per frozen address, not one per session', async () => {
    const { queue, agent, live } = await setup()
    const sender = agent('root')
    const shared = agent('away-root', awayDirectory)
    const first = await queue.send(sender, { recipients: [shared.id], body: 'to ws-away' })
    // The same session id is addressed again after moving, while the first
    // message stays unacknowledged at its original address.
    thirdMembers.push(shared.id)
    live.delete(shared.id)
    const elsewhere = agent('away-root', thirdDirectory)
    const second = await queue.send(sender, { recipients: [elsewhere.id], body: 'to ws-third' })
    await queue.ackInbox(elsewhere, second.seq)
    const state = (queue as unknown as { record(): { inboxes: { sessionId: string; workspaceId: string; cursor: number }[] } }).record()
    expect(state.inboxes.filter(inbox => inbox.sessionId === shared.id)).toEqual([
      { sessionId: shared.id, workspaceId: awayId, cursor: 0 },
      { sessionId: shared.id, workspaceId: thirdId, cursor: second.seq },
    ])
    thirdMembers.pop()
    live.delete(elsewhere.id)
    const back = agent('away-root', awayDirectory)
    expect((await queue.inbox(back)).messages.map(entry => entry.seq)).toEqual([first.seq])
  })

  it('refuses to commit a ledger that breaks its scope, ordering, or bounds', async () => {
    const { queue, agent } = await setup()
    const sender = agent('root')
    const foreign = agent('away-root', awayDirectory)
    const message = await queue.send(sender, { recipients: [foreign.id], body: 'valid' })
    const service = queue as unknown as {
      commit(next: { nextSeq: number; messages: unknown[]; inboxes: unknown[] }): Promise<void>
    }
    const ledger = (messages: unknown[]): { nextSeq: number; messages: unknown[]; inboxes: unknown[] } =>
      ({ nextSeq: 2, messages, inboxes: [{ sessionId: foreign.id, workspaceId: awayId, cursor: 0 }] })
    // A same-workspace addressee could only arrive through a future bug or a
    // hand-written record; the ledger must stay disjoint from the v1 queue.
    await expect(service.commit(ledger([
      { ...message, recipients: [{ sessionId: SessionId('alpha'), workspaceId: homeId }] },
    ]))).rejects.toThrow('must not hold same-workspace mail')
    await expect(service.commit(ledger([{ ...message, recipients: [] }])))
      .rejects.toThrow('must retain an addressee')
    await expect(service.commit(ledger([{ ...message, seq: 2 }])))
      .rejects.toThrow('strictly increasing sequences below its head')
    await expect(service.commit(ledger([message, message])))
      .rejects.toThrow('strictly increasing sequences below its head')
    await expect(service.commit({
      nextSeq: MAX_DIRECT_MESSAGES + 3,
      messages: Array.from({ length: MAX_DIRECT_MESSAGES + 1 }, (_, index) => ({ ...message, seq: index + 1 })),
      inboxes: [],
    })).rejects.toThrow(`above the ${MAX_DIRECT_MESSAGES}-message bound`)
    await expect(service.commit({
      nextSeq: 2,
      messages: [],
      inboxes: Array.from({ length: MAX_DIRECT_INBOXES + 1 }, (_, index) =>
        ({ sessionId: SessionId(`s-${index}`), workspaceId: awayId, cursor: 0 })),
    })).rejects.toThrow(`above the ${MAX_DIRECT_INBOXES}-inbox bound`)
    // The rejected candidates never reached the medium.
    expect((await queue.inbox(foreign)).messages.map(entry => entry.seq)).toEqual([message.seq])
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

  it('never expires unacknowledged mail: a durable ack is the only exit', async () => {
    const { queue, agent } = await setup()
    const sender = agent('root')
    const foreign = agent('away-root', awayDirectory)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const old = await queue.send(sender, { recipients: [foreign.id], body: 'unacknowledged' })
      // Years later, with further writes landing, the unacknowledged message is
      // still readable: no age ceiling may destroy durable mail.
      vi.setSystemTime(new Date('2029-01-01T00:00:00Z'))
      const recent = await queue.send(sender, { recipients: [foreign.id], body: 'recent' })
      expect((await queue.inbox(foreign)).messages.map(entry => entry.seq)).toEqual([old.seq, recent.seq])
      expect(await queue.address(foreign)).toMatchObject({ unread: 2 })
      // Only the acknowledgement compacts it.
      await queue.ackInbox(foreign, old.seq)
      expect((await queue.inbox(foreign, { cursor: 0 })).messages.map(entry => entry.seq)).toEqual([recent.seq])
      await queue.ackInbox(foreign, recent.seq)
      expect((await queue.inbox(foreign, { cursor: 0 })).messages).toEqual([])
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
    expect(await resumed.queue.address(foreign)).toMatchObject({
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
