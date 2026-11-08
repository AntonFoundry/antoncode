import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteResult, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { AgentMailGateway, AgentMailMessage, AgentMailSendOutcome, AgentMailSentEntry, AgentMailPeer, AgentMailSnapshot } from './gateway.ts'

const id = (sessionId: string): SessionId => sessionId as SessionId

type Snapshot = {
  /** Identity of one browser authorization lifetime; never exposed or serialized. */
  readonly authorizationEpoch: object
  readonly refreshRequest?: object
  state: 'unpaired' | 'authorized' | 'revoked'
  workspaceId?: string
  peers: readonly AgentMailPeer[]
  inbox: ReturnType<AgentMailGateway['inbox']>
}
const blank = (): Snapshot => ({
  authorizationEpoch: {}, state: 'unpaired', peers: [],
  inbox: { local: { messages: [], cursor: 0 }, direct: { messages: [], cursor: 0 }, sent: [] },
})
const unwrap = async <T>(call: Promise<RemoteResult<T>>): Promise<T> => {
  const result = await call
  if (!result.ok) throw result.error
  return result.value
}

/** Whether asynchronous work still belongs to this authorized browser lifetime. */
function sameAuthorization(current: Snapshot, source: Snapshot): boolean {
  return current.state === 'authorized' && current.authorizationEpoch === source.authorizationEpoch
}

/** Whether a completed query is still the latest request for its authorization. */
function isCurrentRefresh(current: Snapshot, source: Snapshot, request: object | undefined): boolean {
  return sameAuthorization(current, source) && current.refreshRequest === request
}

/** Append one canonical receipt without mutating a newer authorization's presentation. */
function appendReceipt(
  current: Snapshot, source: Snapshot, receipt: { seq: number },
  entry: Omit<AgentMailSentEntry, 'key' | 'seq' | 'at'>, at: number,
): Snapshot | undefined {
  if (!sameAuthorization(current, source)) return undefined
  const key = `queue:${entry.channel}:${entry.workspaceId}:${receipt.seq}`
  const sent = current.inbox.sent.some(row => row.key === key) ? current.inbox.sent
    : [...current.inbox.sent, { ...entry, key, seq: receipt.seq, at }]
  return { ...current, inbox: { ...current.inbox, sent } }
}

/** Read the complete authorized peer roster without owning browser state. */
async function fetchAllPeers(remote: ClientRemote['agentMail'], sessionId: string, signal?: AbortSignal) {
  const peers: AgentMailPeer[] = []
  let peerCursor: string | undefined
  const visited = new Set<string>()
  for (;;) {
    signal?.throwIfAborted()
    const page = await unwrap(remote.address(id(sessionId), peerCursor, signal))
    peers.push(...page.peers)
    if (!page.hasMorePeers) return { workspaceId: page.workspaceId, peers }
    const next = page.nextPeerCursor
    if (!next || visited.has(next)) throw new Error('Agent Mail peer pagination did not advance')
    visited.add(next)
    peerCursor = next
  }
}
/** Read one complete inbox without acknowledging it or publishing browser state. */
async function fetchInbox(remote: ClientRemote['agentMail'], sessionId: string, channel: 'local' | 'direct', signal?: AbortSignal) {
  const messages: AgentMailMessage[] = []
  let cursor: number | undefined
  let acknowledged = 0
  const visited = new Set<number>()
  for (;;) {
    signal?.throwIfAborted()
    const page = await unwrap(remote.inbox(id(sessionId), channel, cursor, signal))
    acknowledged = page.cursor
    messages.push(...page.messages.map(message => ({
      seq: message.seq, from: message.sender, workspaceId: message.senderWorkspaceId,
      body: message.body, at: message.createdAt,
    })))
    if (!page.hasMore) return { messages, cursor: acknowledged }
    const next = page.messages.at(-1)?.seq
    if (next === undefined || (cursor !== undefined && next <= cursor) || visited.has(next)) {
      throw new Error('Agent Mail inbox pagination did not advance')
    }
    visited.add(next)
    cursor = next
  }
}

/** Detach and freeze one mailbox value without introducing another state owner. */
function aggregateOf(sessionId: string, current: Snapshot): AgentMailSnapshot {
  const page = (value: Snapshot['inbox']['local']): Snapshot['inbox']['local'] => Object.freeze({
    ...value, messages: Object.freeze(value.messages.map(message => Object.freeze({ ...message }))),
  })
  return Object.freeze({
    authorization: Object.freeze({ state: current.state,
      ...(current.state === 'authorized' ? { address: sessionId } : {}),
      ...(current.workspaceId === undefined ? {} : { workspaceId: current.workspaceId }),
    }),
    peers: Object.freeze(current.peers.map(peer => Object.freeze({ ...peer }))),
    inbox: Object.freeze({ ...current.inbox, local: page(current.inbox.local), direct: page(current.inbox.direct),
      sent: Object.freeze(current.inbox.sent.map(entry => Object.freeze({ ...entry, to: Object.freeze([...entry.to]) }))),
    }),
  })
}

/**
 * Create a browser snapshot and compose adapter for the owner-only Agent Mail Remote.
 * @param remote - Generated Agent Mail Remote methods; Host queue services enforce access.
 * @returns Browser-local mailbox state and operations backed by the supplied Remote.
 */
export function createAgentMailGateway(remote: ClientRemote['agentMail']): AgentMailGateway {
  const snapshots = new Map<string, Snapshot>()
  const sources = new Map<string, ObservableSnapshot<AgentMailSnapshot>>()
  const aggregates = new Map<string, AgentMailSnapshot>()
  const listeners = new Map<string, Set<() => void>>()
  let disposed = false
  const isDisposed = (): boolean => disposed
  const authorizations = new Set<() => void>()
  const inboxes = new Set<() => void>()
  const snapshot = (sessionId: string): Snapshot => {
    let current = snapshots.get(sessionId)
    if (current === undefined) { current = blank(); snapshots.set(sessionId, current) }
    return current
  }
  const aggregate = (sessionId: string): AgentMailSnapshot => {
    let value = aggregates.get(sessionId)
    if (value === undefined) {
      value = aggregateOf(sessionId, snapshot(sessionId))
      aggregates.set(sessionId, value)
    }
    return value
  }
  const update = (sessionId: string, next: Snapshot): void => {
    snapshots.set(sessionId, next)
    aggregates.delete(sessionId)
    aggregate(sessionId)
    notifySubscribers(listeners.get(sessionId) ?? [], 'Agent Mail')
    for (const listener of authorizations) listener()
    for (const listener of inboxes) listener()
  }
  const requireAuthorized = (sessionId: string, workspaceId?: string): void => {
    if (disposed) throw new Error('Agent Mail gateway has been disposed')
    const current = snapshot(sessionId)
    if (current.state !== 'authorized'
      || (workspaceId !== undefined && workspaceId !== current.workspaceId)) {
      throw new Error('Agent Mail is not authorized for this session and workspace')
    }
  }
  const refresh = async (sessionId: string, signal?: AbortSignal): Promise<void> => {
    requireAuthorized(sessionId)
    const before = snapshot(sessionId)
    const refreshRequest = {}
    snapshots.set(sessionId, { ...before, refreshRequest })
    const [address, local, direct] = await Promise.all([
      fetchAllPeers(remote, sessionId, signal), fetchInbox(remote, sessionId, 'local', signal), fetchInbox(remote, sessionId, 'direct', signal),
    ])
    const current = snapshot(sessionId)
    if (disposed || signal?.aborted || !isCurrentRefresh(current, before, refreshRequest)) return
    update(sessionId, {
      authorizationEpoch: before.authorizationEpoch, refreshRequest, state: 'authorized', workspaceId: address.workspaceId,
      peers: address.peers, inbox: { local, direct, sent: current.inbox.sent },
    })
  }
  const committed = async (
    sessionId: string, receipt: { seq: number }, source: Snapshot,
    entry: Omit<AgentMailSentEntry, 'key' | 'seq' | 'at'>,
  ): Promise<AgentMailSendOutcome> => {
    const next = appendReceipt(snapshot(sessionId), source, receipt, entry, Date.now())
    if (next === undefined) return { receipt }
    update(sessionId, next)
    const before = snapshot(sessionId)
    const refreshing = refresh(sessionId)
    const refreshRequest = snapshot(sessionId).refreshRequest
    try {
      await refreshing
      return { receipt }
    } catch (error) {
      const refreshError = error instanceof Error ? error.message : String(error)
      const latest = snapshot(sessionId)
      if (isCurrentRefresh(latest, before, refreshRequest)) {
        update(sessionId, { ...latest, inbox: { ...latest.inbox, refreshError } })
      }
      return { receipt, refreshError }
    }
  }
  return {
    source: (sessionId) => {
      if (disposed) throw new Error('Agent Mail gateway has been disposed')
      let source = sources.get(sessionId)
      if (source === undefined) {
        source = { getSnapshot: () => aggregate(sessionId), subscribe: (listener) => {
          let group = listeners.get(sessionId)
          if (group === undefined) { group = new Set(); listeners.set(sessionId, group) }
          group.add(listener)
          return () => { group.delete(listener) }
        } }
        sources.set(sessionId, source)
      }
      return source
    },
    dispose: () => {
      disposed = true
      for (const sessionId of snapshots.keys()) update(sessionId, { ...blank(), state: 'revoked' })
      snapshots.clear()
      listeners.clear(); authorizations.clear(); inboxes.clear(); sources.clear()
      return Promise.resolve()
    },
    authorization: (sessionId) => {
      const current = snapshot(sessionId)
      return {
        state: current.state,
        ...(current.state === 'authorized' ? { address: sessionId } : {}),
        ...(current.workspaceId ? { workspaceId: current.workspaceId } : {}),
      }
    },
    subscribeAuthorization: (listener) => { authorizations.add(listener); return () => { authorizations.delete(listener) } },
    authorize: async (sessionId, signal) => {
      if (disposed) throw new Error('Agent Mail gateway has been disposed')
      if (signal?.aborted) return
      if (snapshot(sessionId).state === 'authorized') return
      const opened = { ...blank(), state: 'authorized' as const }
      update(sessionId, opened)
      try { await refresh(sessionId, signal) } catch (error) {
        if (!isDisposed() && !signal?.aborted && sameAuthorization(snapshot(sessionId), opened)) update(sessionId, blank())
        throw error
      }
    },
    inbox: sessionId => snapshot(sessionId).inbox,
    subscribeInbox: (listener) => { inboxes.add(listener); return () => { inboxes.delete(listener) } },
    peers: sessionId => snapshot(sessionId).peers,
    refresh,
    revoke: (sessionId) => {
      update(sessionId, { ...blank(), state: 'revoked' })
      return Promise.resolve()
    },
    sendLocal: async ({ sessionId, workspaceId, recipients, body, workspaceWide }) => {
      requireAuthorized(sessionId, workspaceId)
      const source = snapshot(sessionId)
      const receipt = await unwrap(remote.send(id(sessionId), 'local', recipients.map(id), body, workspaceWide))
      return committed(sessionId, receipt, source, { channel: 'local', workspaceId, from: sessionId, to: [...recipients], body })
    },
    sendDirect: async ({ sessionId, workspaceId, recipients, body }) => {
      requireAuthorized(sessionId, workspaceId)
      const source = snapshot(sessionId)
      const receipt = await unwrap(remote.send(id(sessionId), 'direct', recipients.map(id), body, false))
      return committed(sessionId, receipt, source, { channel: 'direct', workspaceId, from: sessionId, to: [...recipients], body })
    },
    acknowledge: async ({ sessionId, workspaceId, channel, throughSeq }) => {
      requireAuthorized(sessionId, workspaceId)
      await unwrap(remote.ack(id(sessionId), channel, throughSeq))
      await refresh(sessionId)
    },
  }
}
