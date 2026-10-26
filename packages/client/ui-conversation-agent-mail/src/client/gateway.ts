export interface AgentMailMessage {
  seq: number
  from: string
  workspaceId: string
  body: string
  at: number
}

/** Optional authorized capability: absence or non-authorized status means zero queue operations. */
export interface AgentMailGateway {
  authorization(sessionId: string): {
    state: 'unpaired' | 'authorized' | 'revoked'
    address?: string
    workspaceId?: string
  }
  subscribeAuthorization(listener: () => void): () => void
  /**
   * Authorize the local harness UI for this session's live Agent. The Host
   * mints the grant from the bridge-proven loopback origin; no native code or
   * user confirmation is involved.
   * @param sessionId - the session whose Agent the UI acts as.
   */
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
