import type { ClientRemote, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { AgentMailGateway, AgentMailMessage } from './gateway.ts'

const id = (sessionId: string): SessionId => sessionId as SessionId

type Snapshot = {
  state: 'unpaired' | 'authorized' | 'revoked'
  workspaceId?: string
  peers: readonly { sessionId: string; workspaceId: string }[]
  inbox: ReturnType<AgentMailGateway['inbox']>
}
const blank = (): Snapshot => ({
  state: 'unpaired', peers: [],
  inbox: { local: { messages: [], cursor: 0 }, direct: { messages: [], cursor: 0 } },
})
const unwrap = async <T>(call: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>): Promise<T> => {
  const result = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Create a browser snapshot and compose adapter for the owner-only Agent Mail Remote.
 * @param remote - Generated Agent Mail Remote methods; Host queue services enforce access.
 * @returns Browser-local mailbox state and operations backed by the supplied Remote.
 */
export function createAgentMailGateway(remote: ClientRemote['agentMail']): AgentMailGateway {
  const snapshots = new Map<string, Snapshot>()
  const authorizations = new Set<() => void>()
  const inboxes = new Set<() => void>()
  const snapshot = (sessionId: string): Snapshot => snapshots.get(sessionId) ?? blank()
  const update = (sessionId: string, next: Snapshot): void => {
    snapshots.set(sessionId, next)
    for (const listener of authorizations) listener()
    for (const listener of inboxes) listener()
  }
  const requireAuthorized = (sessionId: string, workspaceId?: string): void => {
    const current = snapshot(sessionId)
    if (current.state !== 'authorized'
      || (workspaceId !== undefined && workspaceId !== current.workspaceId)) {
      throw new Error('Agent Mail is not authorized for this session and workspace')
    }
  }
  const fetchAllPeers = async (sessionId: string) => {
    const peers: { sessionId: string; workspaceId: string }[] = []
    let peerCursor: string | undefined
    const visited = new Set<string>()
    for (;;) {
      const page = await unwrap(remote.address(id(sessionId), peerCursor))
      peers.push(...page.peers.map(peer => ({ sessionId: peer.sessionId, workspaceId: peer.workspaceId })))
      if (!page.hasMorePeers) return { workspaceId: page.workspaceId, peers }
      const next = page.nextPeerCursor
      if (!next || visited.has(next)) throw new Error('Agent Mail peer pagination did not advance')
      visited.add(next)
      peerCursor = next
    }
  }
  const fetchInbox = async (sessionId: string, channel: 'local' | 'direct') => {
    const messages: AgentMailMessage[] = []
    let cursor: number | undefined
    let acknowledged = 0
    const visited = new Set<number>()
    for (;;) {
      const page = await unwrap(remote.inbox(id(sessionId), channel, cursor))
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
  const refresh = async (sessionId: string): Promise<void> => {
    requireAuthorized(sessionId)
    const [address, local, direct] = await Promise.all([
      fetchAllPeers(sessionId), fetchInbox(sessionId, 'local'), fetchInbox(sessionId, 'direct'),
    ])
    if (snapshot(sessionId).state !== 'authorized') return
    update(sessionId, {
      state: 'authorized', workspaceId: address.workspaceId,
      peers: address.peers, inbox: { local, direct },
    })
  }
  return {
    authorization: (sessionId) => {
      const current = snapshot(sessionId)
      return {
        state: current.state,
        ...(current.state === 'authorized' ? { address: sessionId } : {}),
        ...(current.workspaceId ? { workspaceId: current.workspaceId } : {}),
      }
    },
    subscribeAuthorization: (listener) => { authorizations.add(listener); return () => { authorizations.delete(listener) } },
    authorize: async (sessionId) => {
      if (snapshot(sessionId).state === 'authorized') return
      update(sessionId, { ...blank(), state: 'authorized' })
      try { await refresh(sessionId) } catch (error) { update(sessionId, blank()); throw error }
    },
    inbox: sessionId => snapshot(sessionId).inbox,
    subscribeInbox: (listener) => { inboxes.add(listener); return () => { inboxes.delete(listener) } },
    peers: sessionId => snapshot(sessionId).peers,
    refresh,
    revoke: async (sessionId) => { requireAuthorized(sessionId); update(sessionId, { ...blank(), state: 'revoked' }) },
    sendLocal: async ({ sessionId, workspaceId, recipients, body, workspaceWide }) => {
      requireAuthorized(sessionId, workspaceId)
      await unwrap(remote.send(id(sessionId), 'local', recipients.map(id), body, workspaceWide))
      await refresh(sessionId)
    },
    sendDirect: async ({ sessionId, workspaceId, recipient, body }) => {
      requireAuthorized(sessionId, workspaceId)
      await unwrap(remote.send(id(sessionId), 'direct', [id(recipient)], body))
      await refresh(sessionId)
    },
    acknowledge: async ({ sessionId, workspaceId, channel, throughSeq }) => {
      requireAuthorized(sessionId, workspaceId)
      await unwrap(remote.ack(id(sessionId), channel, throughSeq))
      await refresh(sessionId)
    },
  }
}
