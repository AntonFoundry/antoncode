/**
 * term domain contract: interactive PTY sessions for the GUI terminal.
 * A session is a real login shell (`bash -l`, so ~/.bash_profile and
 * ~/.bashrc are sourced) on a node-pty pseudoterminal. Output is pulled:
 * the host retains a bounded tail of raw bytes and the client advances a
 * cursor (`since`), so transport is plain unary polling — no stream frame
 * needed for a first-class terminal.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Interactive PTY-domain unary methods. */
export interface TermApi {
  /**
   * Spawn a login shell. The session buffers its output tail from spawn
   * time, so the first read replays the banner and prompt.
   * @param request - initialcols/rows shape the first prompt layout.
   * @returns the new session's id.
   */
  spawn(request: RpcRequest<{ cols?: number; rows?: number; cwd?: string }>): Promise<RpcResponse<{ sessionId: string }>>

  /**
   * Advance the output cursor.
   * @param request - `since` is the absolute consumed offset into the
   * session's retained output stream.
   * @returns new bytes past `since`, the next cursor, and whether the shell
   * has exited.
   */
  read(request: RpcRequest<{ sessionId: string; since: number }>): Promise<RpcResponse<{ data: string; next: number; exited: boolean }>>

  /** Write raw bytes to the shell (typed keys, pasted text, control chars). */
  input(request: RpcRequest<{ sessionId: string; data: string }>): Promise<RpcResponse<{ wrote: true }>>

  /** Resize the pseudoterminal (drives SIGWINCH → shell $COLUMNS/$LINES). */
  resize(request: RpcRequest<{ sessionId: string; cols: number; rows: number }>): Promise<RpcResponse<{ resized: true }>>

  /** Terminate the session (window closed). */
  dispose(request: RpcRequest<{ sessionId: string }>): Promise<RpcResponse<{ disposed: true }>>
}
