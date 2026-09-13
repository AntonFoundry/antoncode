/**
 * Browser-safe background-job domain contract. The registry's live records
 * never cross the wire; a view is the subset a human list needs, minted fresh
 * per push.
 */

import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * One background job as the client sees it.
 *
 * Three registry fields are deliberately absent. `ownerSession` is redundant
 * beside the frame's own `sessionId`; `reported` is an internal notice-delivery
 * bit with no user meaning; `outputLimitBytes` is producer-owned model
 * presentation policy that never reaches a human surface.
 */
export interface JobView {
  /** Registry-issued `<kind>-N` identity, stable for the task's whole life. */
  id: JobId
  /**
   * Producer kind (`bash`, `pwsh`, `pty-send`, `subagent`, …). Kept as a bare
   * string because producer plugins extend the kind map by declaration merging,
   * so no client build can enumerate the closed set.
   */
  kind: string
  /** Producer-supplied one-line label: the command, or the delegation description. */
  label: string
  /** Current lifecycle state. */
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  /** Kind-specific status detail ('exit code: 3'), present once the producer supplied one. */
  detail?: string
  /** Epoch ms when the task was registered. */
  startedAt: number
  /** Epoch ms when the task settled; absent while live. */
  finishedAt?: number
}

/**
 * Background-job unary methods. The read side is the `session/jobs` mux frame
 * (the registry's `onJobsChanged` push mints these views); the only mutation
 * is the same kill the model-facing `job_kill` tool issues. Fire-and-return:
 * `requested` acknowledges the admitted cancel signal, not quiescence — the
 * row settles through the next change push.
 */
export interface JobsApi {
  /**
   * Request cancellation of one background job. The browser is not a registry
   * caller, so the handler resolves the owning session's Agent itself; an
   * absent id rejects with `job-not-found`.
   * @param request - the job id to kill.
   * @returns how the request landed: `requested` (cancel signal admitted) or
   *   `already-finished` (the job had already settled).
   */
  kill(request: RpcRequest<{ jobId: JobId }>): Promise<RpcResponse<{ killed: 'requested' | 'already-finished' }>>
}
