/**
 * orchestrator domain contract. One read that composes the board's inputs —
 * workspaces with their session accounts plus the visible session summaries —
 * so the Orchestrator board derives its run tree in a single round trip, and
 * one write that lets a card act on a run. The summaries are the exact
 * `session.list` projection (including the live `running` flag), so the board
 * needs no recency heuristics of its own.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { SessionSummary } from './sessions.ts'
import type { WorkspaceView } from './workspace.ts'

/** orchestrator-domain unary methods (the map keys orchestrator.* of RpcMethodMap). */
export interface OrchestratorApi {
  /**
   * Snapshots everything the board renders: every workspace in the registry's
   * durable display order (with `sessionIds` accounts), the registry-global
   * archive set, and the same visible-session summaries `session.list` serves
   * (attached sessions from memory, cold sessions merged from the persistence
   * store; `running` is the attached agent's live status, never a heuristic).
   */
  board(request: RpcRequest<{}>): Promise<RpcResponse<{
    items: WorkspaceView[]
    archivedSessionIds: SessionId[]
    sessions: SessionSummary[]
  }>>

  /**
   * Acts on one run from a board card. `kill` cancels the attached agent for
   * `sessionId` — the same business action as `session.cancel` (subagent
   * ownership respected); acting on a session that is not attached fails with
   * `session-not-found`.
   */
  act(request: RpcRequest<{ sessionId: SessionId; action: 'kill' }>): Promise<RpcResponse<{ accepted: true }>>
}
