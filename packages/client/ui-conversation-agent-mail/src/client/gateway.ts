export interface AgentMailMessage {
  seq: number
  from: string
  workspaceId: string
  body: string
  at: number
}

/** Browser-facing Agent Mail operations and local presentation state. */
export interface AgentMailGateway {
  authorization(sessionId: string): {
    state: 'unpaired' | 'authorized' | 'revoked'
    address?: string
    workspaceId?: string
  }
  subscribeAuthorization(listener: () => void): () => void
  /** Open the owner-only Remote mailbox for this Session. */
  authorize(sessionId: string): Promise<void>
  inbox(sessionId: string): {
    local: { messages: readonly AgentMailMessage[]; cursor: number }
    direct: { messages: readonly AgentMailMessage[]; cursor: number }
  }
  subscribeInbox(listener: () => void): () => void
  peers(sessionId: string): readonly { sessionId: string; workspaceId: string }[]
  refresh(sessionId: string): Promise<void>
  revoke(sessionId: string): Promise<void>
  sendLocal(input: {
    sessionId: string
    workspaceId: string
    recipients: readonly string[]
    body: string
    workspaceWide: boolean
  }): Promise<void>
  sendDirect(input: { sessionId: string; workspaceId: string; recipient: string; body: string }): Promise<void>
  acknowledge(input: {
    sessionId: string
    workspaceId: string
    channel: 'local' | 'direct'
    throughSeq: number
  }): Promise<void>
}
