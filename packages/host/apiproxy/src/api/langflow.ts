/**
 * langflow domain contract. One read that snapshots the LangFlow sidecar's
 * lifecycle state and two writes that start/stop the local LangFlow server
 * embedded in the Workflows tab. Every method mirrors one `ctx.langflow`
 * call; the wire shape is the sidecar's exact status snapshot.
 */

import type { LangflowStatus } from '@deepseek-ai/dsh-langflow-sidecar'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** langflow-domain unary methods (the map keys langflow.* of RpcMethodMap). */
export interface LangflowApi {
  /**
   * Snapshots the sidecar lifecycle state. Safe to poll: a stopped sidecar
   * reports `stopped` without touching any child.
   */
  status(request: RpcRequest<{}>): Promise<RpcResponse<{ status: LangflowStatus }>>

  /**
   * Spawns the child (`command langflow run --host 127.0.0.1 --port port`)
   * and resolves at readiness — any answered HTTP response — or into the
   * `error` state with the startup reason (launcher missing, early exit with
   * the stderr tail, readiness timeout).
   */
  start(request: RpcRequest<{}>): Promise<RpcResponse<{ status: LangflowStatus }>>

  /**
   * Terminates the whole child process tree (SIGTERM → grace → SIGKILL
   * through the subprocess seam) and reports the resulting `stopped` state.
   */
  stop(request: RpcRequest<{}>): Promise<RpcResponse<{ status: LangflowStatus }>>
}
