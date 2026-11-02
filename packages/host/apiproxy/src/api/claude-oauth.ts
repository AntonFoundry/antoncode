/**
 * Claude subscription-login domain contract: the web face of the
 * server-side paste-back flow (`ClaudeLoginFlow` in `dsh-llm-claude`). The
 * UI drives `start` (approval link for the operator), then `submit`s the
 * pasted code — the exchange is synchronous, so unlike the device flow no
 * polling state exists. Token material never crosses this wire — snapshots
 * carry progress and outcome only.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** UI-safe login view; mirrors `ClaudeLoginSnapshot` without token material. */
export interface ClaudeLoginWire {
  loginId: string
  status: 'pending' | 'done' | 'failed' | 'cancelled'
  verificationUri?: string
  error?: string
}

/** Claude-login unary methods (the map keys claudeOAuth.* of RpcMethodMap). */
export interface ClaudeOAuthApi {
  /**
   * Start one login: builds the browser approval link immediately. Fails
   * with `claude-oauth-unavailable` while `llm-claude` is not installed, or
   * `claude-login-invalid` when too many logins are already pending.
   */
  start(request: RpcRequest<{}>): Promise<RpcResponse<{ login: ClaudeLoginWire }>>

  /**
   * Redeem one pasted `{code}#{state}` (or bare code) and persist the
   * session. Only valid while pending — otherwise `claude-login-invalid` —
   * with foreign states and exchange denials rejected the same way.
   */
  submit(request: RpcRequest<{ loginId: string; pasted: string }>): Promise<RpcResponse<{ login: ClaudeLoginWire }>>

  /**
   * Abandon one login. Unknown ids fail with `claude-login-not-found`;
   * terminal logins report their current view.
   */
  cancel(request: RpcRequest<{ loginId: string }>): Promise<RpcResponse<{ login: ClaudeLoginWire }>>
}
