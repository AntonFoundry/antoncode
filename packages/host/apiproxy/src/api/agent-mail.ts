import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { WorkspaceId } from './workspace.ts'

export type AgentMailOperation =
  | 'address' | 'local-read' | 'local-send' | 'local-ack'
  | 'direct-read' | 'direct-send' | 'direct-ack'
export interface AgentMailAddress {
  sessionId: SessionId
  workspaceId: WorkspaceId
  inboxCursor: number
  unread: number
  peers: readonly { sessionId: SessionId; workspaceId: WorkspaceId; transport: 'direct' | 'workspace-queue' }[]
  hasMorePeers: boolean
  nextPeerCursor?: string
}
export interface AgentMailMessage {
  seq: number
  sender: SessionId
  senderWorkspaceId: WorkspaceId
  body: string
  createdAt: number
}

export interface AgentMailApi {
  /**
   * Authorizes the loopback harness UI for this exact live Agent without a
   * native code. The HTTP carrier already proves the request came through the
   * bridge for the accepted local origin; the returned grant is scoped to
   * this Agent, origin, workspace, and operation set.
   */
  authorize(request: RpcRequest<{ sessionId: SessionId; operations: AgentMailOperation[] }>, origin?: string):
  Promise<RpcResponse<{ grant: string }>>
  /** Starts a private native-display challenge; no code or binding returned to the browser. */
  begin(request: RpcRequest<{ sessionId: SessionId; operations: AgentMailOperation[] }>, origin?: string):
  Promise<RpcResponse<{ requestId: string; expiresAt: number }>>
  redeem(request: RpcRequest<{ sessionId: SessionId; requestId: string; code: string }>, origin?: string):
  Promise<RpcResponse<{ grant: string }>>
  revoke(request: RpcRequest<{ sessionId: SessionId; grant: string }>, origin?: string):
  Promise<RpcResponse<{ revoked: true }>>
  address(request: RpcRequest<{ sessionId: SessionId; grant: string; peerCursor?: string; peerLimit?: number }>, origin?: string):
  Promise<RpcResponse<AgentMailAddress>>
  inbox(request: RpcRequest<{ sessionId: SessionId; grant: string; channel: 'local' | 'direct'; cursor?: number; limit?: number }>, origin?: string):
  Promise<RpcResponse<{ messages: AgentMailMessage[]; cursor: number; hasMore: boolean }>>
  send(request: RpcRequest<{
    sessionId: SessionId
    grant: string
    channel: 'local' | 'direct'
    recipients: SessionId[]
    workspaceWide?: boolean
    body: string
  }>, origin?: string): Promise<RpcResponse<{ seq: number }>>
  ack(request: RpcRequest<{
    sessionId: SessionId
    grant: string
    channel: 'local' | 'direct'
    throughSeq: number
  }>, origin?: string): Promise<RpcResponse<{ cursor: number }>>
}
