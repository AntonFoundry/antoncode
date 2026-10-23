/** Optional authorized capability: absence or non-authorized status means zero queue operations. */
export interface AgentMailGateway {
  authorization(sessionId: string): { state: 'unpaired' | 'pairing' | 'authorized' | 'revoked'; address?: string }
  subscribeAuthorization(listener: () => void): () => void
  inbox(sessionId: string): {
    messages: readonly { seq: number; from: string; workspaceId: string; body: string; at: number }[]
    cursor: number
  }
  subscribeInbox(listener: () => void): () => void
  peers(sessionId: string): readonly { sessionId: string; workspaceId: string }[]
  sendLocal(input: {
    sessionId: string
    workspaceId: string
    recipients: readonly string[]
    body: string
    workspaceWide: boolean
  }): Promise<void>
  sendDirect(input: { sessionId: string; workspaceId: string; recipient: string; body: string }): Promise<void>
  acknowledge(input: { sessionId: string; workspaceId: string; throughSeq: number }): Promise<void>
}
