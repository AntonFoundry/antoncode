/** Browser-safe Agent Mail response values. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Agent Mail exposes cross-workspace discovery only to the owner. */
    'agent-mail/owner-required': { readonly operation: string }
    /** Captured live identity or authorized workspace no longer matches. */
    'agent-mail/address-changed': { readonly sessionId: SessionId }
  }
}

/** Serialized inbox row shared by local and direct mail. */
export interface AgentMailRow {
  readonly seq: number
  readonly sender: SessionId
  readonly senderWorkspaceId: WorkspaceId
  readonly body: string
  readonly createdAt: number
}

/** Address and one discoverable peer page. */
export interface AgentMailAddress {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  readonly inboxCursor: number
  readonly unread: number
  readonly peers: readonly { sessionId: SessionId; workspaceId: WorkspaceId; transport: 'direct' | 'workspace-queue' }[]
  readonly hasMorePeers: boolean
  readonly nextPeerCursor?: string
}

/** One bounded page of an Agent's mailbox. */
export interface AgentMailPage {
  readonly messages: readonly AgentMailRow[]
  readonly cursor: number
  readonly hasMore: boolean
}

/** Coalesced invalidation within one watch generation; reconnect starts at zero. */
export interface AgentMailInvalidation {
  readonly revision: number
}
