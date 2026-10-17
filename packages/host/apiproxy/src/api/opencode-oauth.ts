/**
 * OpenCode Zen workspace-login domain contract: the web face of the
 * server-side device flow (`ZenLoginFlow` in `dsh-llm-opencode`). The UI
 * drives `start` (code and link for the operator), polls `status` until the
 * browser approval lands, then `select`s the billed workspace (or omits it)
 * and the session persists through the credentials seam. Token material never
 * crosses this wire — snapshots carry progress and outcome only.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Billable workspace offered by one login. */
export interface OAuthOrgWire {
  id: string
  name: string
}

/** UI-safe login view; mirrors `ZenLoginSnapshot` without token material. */
export interface OAuthLoginWire {
  loginId: string
  status: 'pending' | 'awaiting-org' | 'done' | 'denied' | 'expired' | 'cancelled'
  userCode?: string
  verificationUri?: string
  intervalSeconds?: number
  expiresInSeconds?: number
  orgs?: OAuthOrgWire[]
  orgID?: string
  allowedModelCount?: number
  error?: string
}

/** OpenCode-login unary methods (the map keys opencodeOAuth.* of RpcMethodMap). */
export interface OpencodeOAuthApi {
  /**
   * Start one login: issues the device code immediately and polls for the
   * browser approval in the background. Fails with `opencode-oauth-unavailable`
   * while `llm-opencode` is not installed, or `opencode-login-invalid` when
   * too many logins are already pending.
   */
  start(request: RpcRequest<{}>): Promise<RpcResponse<{ login: OAuthLoginWire }>>

  /**
   * Snapshot one login for UI polling. Unknown ids fail with
   * `opencode-login-not-found`.
   */
  status(request: RpcRequest<{ loginId: string }>): Promise<RpcResponse<{ login: OAuthLoginWire }>>

  /**
   * Record the billed workspace and persist the session; an omitted org
   * keeps the session unbilled. Only valid while awaiting the pick —
   * otherwise `opencode-login-invalid` — and unknown workspaces are rejected
   * the same way.
   */
  select(request: RpcRequest<{ loginId: string; orgID?: string }>): Promise<RpcResponse<{ login: OAuthLoginWire }>>

  /**
   * Abort one login. Unknown ids fail with `opencode-login-not-found`;
   * terminal logins report their current view.
   */
  cancel(request: RpcRequest<{ loginId: string }>): Promise<RpcResponse<{ login: OAuthLoginWire }>>
}
