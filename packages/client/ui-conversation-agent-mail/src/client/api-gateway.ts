import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AgentMailGateway, AgentMailMessage } from './gateway.ts'

const operations = [
  'address', 'local-read', 'local-send', 'local-ack', 'direct-read', 'direct-send', 'direct-ack',
] as const
const id = (sessionId: string): SessionId => sessionId as SessionId

type Snapshot = {
  state: 'unpaired' | 'authorized' | 'revoked'
  grant?: string
  workspaceId?: string
  peers: readonly { sessionId: string; workspaceId: string }[]
  inbox: ReturnType<AgentMailGateway['inbox']>
}
const blank = (): Snapshot => ({
  state: 'unpaired', peers: [],
  inbox: { local: { messages: [], cursor: 0 }, direct: { messages: [], cursor: 0 } },
})
const unwrap = async <T>(call: Promise<{
  result: { ok: true; value: T } | { ok: false; error: { message: string } }
}>): Promise<T> => {
  const { result } = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Browser adapter only. Every operation still requires Host verification of
 * the grant and session identity: this local state is presentation, not auth.
 * Grants exist only in volatile browser memory and disappear on page reload.
 */
export function createAgentMailGateway(api: IApiClient): AgentMailGateway {
  const snapshots = new Map<string, Snapshot>()
  const authorizations = new Set<() => void>()
  const inboxes = new Set<() => void>()
  const snapshot = (sessionId: string): Snapshot => snapshots.get(sessionId) ?? blank()
  const update = (sessionId: string, next: Snapshot): void => {
    snapshots.set(sessionId, next)
    for (const listener of authorizations) listener()
    for (const listener of inboxes) listener()
  }
  const requireGrant = (sessionId: string, workspaceId?: string): string => {
    const current = snapshot(sessionId)
    if (current.state !== 'authorized' || !current.grant
      || (workspaceId !== undefined && (!current.workspaceId || workspaceId !== current.workspaceId))) {
      throw new Error('Agent Mail is not authorized for this session and workspace')
    }
    return current.grant
  }
  const fetchAllPeers = async (sessionId: string, grant: string) => {
    const peers: { sessionId: string; workspaceId: string }[] = []
    let peerCursor: string | undefined
    const visited = new Set<string>()
    for (;;) {
      const page = await unwrap(api.agentMail.address({ sessionId: id(sessionId), grant, ...(peerCursor ? { peerCursor } : {}) }))
      peers.push(...page.peers.map(peer => ({ sessionId: peer.sessionId, workspaceId: peer.workspaceId })))
      if (!page.hasMorePeers) return { workspaceId: page.workspaceId, peers }
      const next = page.nextPeerCursor
      if (!next || visited.has(next)) throw new Error('Agent Mail peer pagination did not advance')
      visited.add(next)
      peerCursor = next
    }
  }
  const fetchInbox = async (sessionId: string, grant: string, channel: 'local' | 'direct') => {
    const messages: AgentMailMessage[] = []
    let cursor: number | undefined
    let acknowledged = 0
    const visited = new Set<number>()
    for (;;) {
      const page = await unwrap(api.agentMail.inbox({
        sessionId: id(sessionId), grant, channel, limit: 100, ...(cursor !== undefined ? { cursor } : {}),
      }))
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
    const grant = requireGrant(sessionId)
    const [address, local, direct] = await Promise.all([
      fetchAllPeers(sessionId, grant),
      fetchInbox(sessionId, grant, 'local'), fetchInbox(sessionId, grant, 'direct'),
    ])
    if (snapshot(sessionId).grant !== grant) return
    update(sessionId, {
      state: 'authorized', grant, workspaceId: address.workspaceId,
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
    subscribeAuthorization: (listener) => {
      authorizations.add(listener)
      return () => { authorizations.delete(listener) }
    },
    authorize: async (sessionId) => {
      const current = snapshot(sessionId)
      if (current.state === 'authorized') return
      const value = await unwrap(api.agentMail.authorize({ sessionId: id(sessionId), operations: [...operations] }))
      update(sessionId, { ...blank(), state: 'authorized', grant: value.grant })
      try { await refresh(sessionId) } catch (error) {
        update(sessionId, blank())
        throw error
      }
    },
    inbox: sessionId => snapshot(sessionId).inbox,
    subscribeInbox: (listener) => {
      inboxes.add(listener)
      return () => { inboxes.delete(listener) }
    },
    peers: sessionId => snapshot(sessionId).peers,
    refresh,
    revoke: async (sessionId) => {
      const grant = requireGrant(sessionId)
      await unwrap(api.agentMail.revoke({ sessionId: id(sessionId), grant }))
      update(sessionId, { ...blank(), state: 'revoked' })
    },
    sendLocal: async ({ sessionId, workspaceId, recipients, body, workspaceWide }) => {
      const grant = requireGrant(sessionId, workspaceId)
      await unwrap(api.agentMail.send({
        sessionId: id(sessionId), grant, channel: 'local', recipients: recipients.map(id), body, workspaceWide,
      }))
      await refresh(sessionId)
    },
    sendDirect: async ({ sessionId, workspaceId, recipient, body }) => {
      const grant = requireGrant(sessionId, workspaceId)
      await unwrap(api.agentMail.send({ sessionId: id(sessionId), grant, channel: 'direct', recipients: [id(recipient)], body }))
      await refresh(sessionId)
    },
    acknowledge: async ({ sessionId, workspaceId, channel, throughSeq }) => {
      const grant = requireGrant(sessionId, workspaceId)
      await unwrap(api.agentMail.ack({ sessionId: id(sessionId), grant, channel, throughSeq }))
      await refresh(sessionId)
    },
  }
}
