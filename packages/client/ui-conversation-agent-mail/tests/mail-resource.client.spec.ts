import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteResult, SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteStream } from '../../../api/gateway/src/client/remote-stream.ts'
import { RemoteStreamCarrierError } from '../../../api/gateway/src/client/stream-client.ts'
import { ResourceRegistry } from '../../resources/src/client/resources.ts'
import type { AgentMailSnapshot } from '../src/client/gateway.ts'
import { createAgentMailGateway } from '../src/client/api-gateway.ts'
import { agentMailResourceAddress, createAgentMailResourceProvider } from '../src/client/mail-resource.ts'

type MailRemote = Pick<ClientRemote, 'agentMail' | '$stream'>
type Invalidation = { readonly revision: number }
const sessionId = 'session' as SessionId
const workspaceId = 'workspace' as WorkspaceId

/** Script only the generated Host methods; retain the actual reconnect supervisor. */
function fixture() {
  const ready = Promise.withResolvers<undefined>()
  const ended = Promise.withResolvers<undefined>()
  const watchEntered = Promise.withResolvers<undefined>()
  const address = vi.fn<ClientRemote['agentMail']['address']>(async () => ({ ok: true, value: {
    sessionId, workspaceId, peers: [], hasMorePeers: false, inboxCursor: 0, unread: 0,
  } }))
  const inbox = vi.fn<ClientRemote['agentMail']['inbox']>(async () => ({ ok: true, value: {
    messages: [], cursor: 0, hasMore: false,
  } }))
  const send = vi.fn<ClientRemote['agentMail']['send']>(async () => ({ ok: true, value: { seq: 7 } }))
  const ack = vi.fn<ClientRemote['agentMail']['ack']>(async () => ({ ok: true, value: { cursor: 0 } }))
  let openWatch = async function* (signal: AbortSignal): AsyncIterable<Invalidation> {
    await ready.promise
    if (signal.aborted) return
    yield { revision: 0 }
    await waitForAbort(signal)
  }
  const watch = vi.fn<ClientRemote['agentMail']['watch']>((_session, supplied) => {
    const lifetime = new AbortController()
    const signal = supplied === undefined ? lifetime.signal : AbortSignal.any([supplied, lifetime.signal])
    const values = (async function* () {
      watchEntered.resolve(undefined)
      try { yield* openWatch(signal) } finally { ended.resolve(undefined) }
    })()
    return { send() {}, end() {}, dispose() { lifetime.abort() }, [Symbol.asyncIterator]: () => values }
  })
  const remote: MailRemote = {
    agentMail: { address, inbox, send, ack, watch },
    $stream: options => new RemoteStream({ generation: createSnapshotStore({ id: 1, host: { home: '/home/fixture' } }) }, options),
  }
  return { remote, ready, ended, watchEntered, address, inbox, send,
    watchWith(open: typeof openWatch) { openWatch = open },
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
}

it('waits for watch readiness before initial reads and closes observation when its resource releases', async () => {
  const f = fixture()
  const gateway = createAgentMailGateway(f.remote.agentMail)
  const lifetime = new AbortController()
  const iterator = createAgentMailResourceProvider(gateway, f.remote)
    .open(agentMailResourceAddress(sessionId), { signal: lifetime.signal })[Symbol.asyncIterator]()
  try {
    expect((await iterator.next()).value).toMatchObject({ ok: true, value: { authorization: { state: 'unpaired' } } })
    expect(f.address).not.toHaveBeenCalled()
    const next = iterator.next()
    f.ready.resolve(undefined)
    await next
    await vi.waitFor(() => { expect(f.inbox).toHaveBeenCalledTimes(2) })
  } finally {
    lifetime.abort()
    f.ready.resolve(undefined)
    await iterator.return?.()
    await f.ended.promise
    await gateway.dispose()
  }
})

it('coalesces burst invalidations into one follow-up query', async () => {
  const f = fixture()
  const burst = Promise.withResolvers<undefined>()
  const accepted = Promise.withResolvers<undefined>()
  f.watchWith(async function* (signal) {
    yield { revision: 0 }
    await burst.promise
    yield { revision: 1 }; yield { revision: 2 }; yield { revision: 3 }
    accepted.resolve(undefined)
    await waitForAbort(signal)
  })
  const gateway = createAgentMailGateway(f.remote.agentMail)
  const lifetime = new AbortController()
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.address>>>()
  const observed = consume(gateway, f.remote, lifetime.signal)
  try {
    await vi.waitFor(() => { expect(gateway.authorization(sessionId).workspaceId).toBe(workspaceId) })
    f.address.mockImplementationOnce(() => pending.promise)
    burst.resolve(undefined)
    await accepted.promise
    pending.resolve({ ok: true, value: { sessionId, workspaceId, peers: [], hasMorePeers: false, inboxCursor: 0, unread: 0 } })
    await vi.waitFor(() => { expect(f.address).toHaveBeenCalledTimes(3) })
  } finally {
    burst.resolve(undefined)
    pending.resolve({ ok: true, value: { sessionId, workspaceId, peers: [], hasMorePeers: false, inboxCursor: 0, unread: 0 } })
    lifetime.abort(); await observed; await gateway.dispose()
  }
})

it.each(['remote-access/denied', 'agent-mail/address-changed'] as const)(
  'clears previously authorized sensitive data when the actual supervisor reports %s', async (code) => {
    const f = fixture()
    const lost = Promise.withResolvers<undefined>()
    f.inbox.mockResolvedValue({ ok: true, value: {
      messages: [{ seq: 1, sender: sessionId, senderWorkspaceId: workspaceId, body: 'private correspondence', createdAt: 1 }],
      cursor: 0, hasMore: false,
    } })
    f.watchWith(async function* () {
      yield { revision: 0 }
      await lost.promise
      if (code === 'remote-access/denied') {
        throw new RemoteError(code, 'owner access ended', { action: 'agentMail/watch', reason: 'no-allow' })
      }
      throw new RemoteError(code, 'address authority ended', { sessionId })
    })
    const gateway = createAgentMailGateway(f.remote.agentMail)
    await gateway.authorize(sessionId)
    const lifetime = new AbortController()
    const frames: RemoteResult<AgentMailSnapshot>[] = []
    const iterator = createAgentMailResourceProvider(gateway, f.remote)
      .open(agentMailResourceAddress(sessionId), { signal: lifetime.signal })[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      if (first.done) throw new Error('Mail resource ended before its initial snapshot')
      frames.push(first.value)
      await f.watchEntered.promise
      lost.resolve(undefined)
      for (;;) {
        const next = await iterator.next()
        if (next.done) throw new Error('Mail resource ended before reporting authority loss')
        frames.push(next.value)
        if (!next.value.ok) break
      }
      expect(frames.at(-1)).toMatchObject({ ok: false, error: { code } })
      expect(frames.at(-2)).toMatchObject({ ok: true, value: {
        authorization: { state: 'revoked' }, peers: [], inbox: { local: { messages: [] }, direct: { messages: [] }, sent: [] },
      } })
    } finally {
      lost.resolve(undefined); lifetime.abort(); await iterator.return?.(); await gateway.dispose()
    }
  },
)

it('reopens the actual supervisor generation and rejects an old generation query settlement', async () => {
  const f = fixture()
  const reconnect = Promise.withResolvers<undefined>()
  let generations = 0
  f.watchWith(async function* (signal) {
    yield { revision: 0 }
    if (++generations === 1) { await reconnect.promise; throw new RemoteStreamCarrierError('carrier lost') }
    await waitForAbort(signal)
  })
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.address>>>()
  f.address.mockImplementationOnce(() => pending.promise)
  const gateway = createAgentMailGateway(f.remote.agentMail)
  const lifetime = new AbortController()
  const observed = consume(gateway, f.remote, lifetime.signal)
  try {
    await vi.waitFor(() => { expect(f.address).toHaveBeenCalledTimes(1) })
    reconnect.resolve(undefined)
    await vi.waitFor(() => { expect(generations).toBe(2) })
    pending.resolve({ ok: true, value: {
      sessionId, workspaceId: 'obsolete' as WorkspaceId, peers: [], hasMorePeers: false, inboxCursor: 0, unread: 0,
    } })
    await vi.waitFor(() => { expect(gateway.authorization(sessionId).workspaceId).toBe(workspaceId) })
  } finally {
    reconnect.resolve(undefined)
    pending.resolve({ ok: true, value: { sessionId, workspaceId, peers: [], hasMorePeers: false, inboxCursor: 0, unread: 0 } })
    lifetime.abort(); await observed; await gateway.dispose()
  }
})

it('publishes a committed outbox row while its refresh is pending without another watch notification', async () => {
  const f = fixture()
  f.ready.resolve(undefined)
  const gateway = createAgentMailGateway(f.remote.agentMail)
  const lifetime = new AbortController()
  const frames: RemoteResult<AgentMailSnapshot>[] = []
  const observed = consume(gateway, f.remote, lifetime.signal, frames)
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.address>>>()
  try {
    await vi.waitFor(() => { expect(gateway.authorization(sessionId).workspaceId).toBe(workspaceId) })
    f.address.mockImplementationOnce(() => pending.promise)
    const sending = gateway.sendDirect({ sessionId, workspaceId, recipients: ['recipient'], body: 'committed before refresh' })
    await vi.waitFor(() => { expect(frames.some(frame => frame.ok && frame.value.inbox.sent.length === 1)).toBe(true) })
    pending.resolve({ ok: true, value: { sessionId, workspaceId, peers: [], hasMorePeers: false, inboxCursor: 0, unread: 0 } })
    await sending
  } finally {
    pending.resolve({ ok: true, value: { sessionId, workspaceId, peers: [], hasMorePeers: false, inboxCursor: 0, unread: 0 } })
    lifetime.abort(); await observed; await gateway.dispose()
  }
})

it('does not open observation for an aborted resource and rejects noncanonical addresses', async () => {
  const f = fixture()
  const gateway = createAgentMailGateway(f.remote.agentMail)
  const provider = createAgentMailResourceProvider(gateway, f.remote)
  const lifetime = new AbortController()
  lifetime.abort()
  const empty = provider.open(agentMailResourceAddress(sessionId), { signal: lifetime.signal })[Symbol.asyncIterator]()
  expect((await empty.next()).done).toBe(true)
  expect(f.remote.agentMail.watch).not.toHaveBeenCalled()
  const invalid = provider.open('dsh-resource://agentmail/session/', { signal: new AbortController().signal })[Symbol.asyncIterator]()
  await expect(invalid.next()).rejects.toThrow('Invalid Agent Mail resource address')
  await gateway.dispose()
})

it('keeps manual mailbox refresh visible after terminal observation failure without claiming watch recovery', async () => {
  const f = fixture()
  const stopWatch = Promise.withResolvers<undefined>()
  let body = 'original'
  f.inbox.mockImplementation(async () => ({ ok: true, value: {
    messages: [{ seq: 1, sender: sessionId, senderWorkspaceId: workspaceId, body, createdAt: 1 }], cursor: 0, hasMore: false,
  } }))
  f.watchWith(async function* () {
    yield { revision: 0 }
    await stopWatch.promise
    throw new RemoteError('gateway/internal', 'watch transport ended', {})
  })
  const gateway = createAgentMailGateway(f.remote.agentMail)
  const ctx = new Context()
  const resources = new ResourceRegistry(ctx)
  const releaseProvider = resources.register(createAgentMailResourceProvider(gateway, f.remote))
  const source = resources.source(agentMailResourceAddress(sessionId))
  const release = source.subscribe(() => {})
  try {
    await vi.waitFor(() => { expect(source.getSnapshot().value).toMatchObject({ inbox: { local: { messages: [{ body: 'original' }] } } }) })
    stopWatch.resolve(undefined)
    await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('failed') })
    body = 'updated by explicit refresh'
    await gateway.refresh(sessionId)
    await vi.waitFor(() => {
      expect(source.getSnapshot().value).toMatchObject({ inbox: { local: { messages: [{ body }] } } })
      expect(source.getSnapshot().status).toBe('failed')
    })
  } finally {
    stopWatch.resolve(undefined); release(); releaseProvider(); await gateway.dispose(); await ctx.fiber.dispose()
  }
})

async function consume(
  gateway: ReturnType<typeof createAgentMailGateway>, remote: MailRemote, signal: AbortSignal,
  frames: RemoteResult<AgentMailSnapshot>[] = [],
): Promise<void> {
  for await (const frame of createAgentMailResourceProvider(gateway, remote).open(agentMailResourceAddress(sessionId), { signal })) {
    frames.push(frame)
  }
}
