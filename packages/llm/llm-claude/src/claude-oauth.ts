/**
 * Claude Code subscription OAuth (PKCE authorization-code flow with manual
 * code paste-back), adapted from the Claude Code CLI's login mechanics as
 * observed on the wire (see OAUTH FACTS below): no API keys to manage — the
 * operator approves once in the browser, pastes the shown code, the harness
 * stores the tokens, and refresh stays silent.
 *
 * Flow: build an authorize URL (client `9d1c250a-…`, S256 PKCE, manual
 * redirect); the operator approves and pastes the code; `POST
 * {console}/v1/oauth/token` exchanges it for access/refresh tokens;
 * `POST` with `grant_type=refresh_token` renews silently. Token state lives
 * in the credentials seam as one JSON blob (never logged), under a
 * configurable reference. Inference presents the access token as
 * `Authorization: Bearer` with the `oauth-2025-04-20` beta — pi-ai's
 * Anthropic implementation already keys Claude Code identity off the
 * `sk-ant-oat` token family, so this package carries no wire code beyond
 * auth.
 *
 * OAUTH FACTS (protocol endpoints, client id, scopes, PKCE, beta header,
 * and token shapes observed in Claude Code 2.1.292/http traffic; functional
 * facts reimplemented here in original code, not copied expression):
 * authorize `https://platform.claude.com/oauth/authorize`, token
 * `https://platform.claude.com/v1/oauth/token`, manual redirect
 * `https://platform.claude.com/oauth/code/callback`, client id
 * `9d1c250a-e61b-44d9-88ed-5944d1962f5e`, scopes `org:create_api_key
 * user:profile user:inference user:sessions:claude_code user:mcp_servers
 * user:file_upload`, beta `oauth-2025-04-20`, token family `sk-ant-oat01`.
 *
 * @module dsh-llm-claude/claude-oauth
 */

import { createHash, randomBytes } from 'node:crypto'

/** Claude console root serving OAuth authorize and token endpoints. */
export const CLAUDE_CONSOLE_URL = 'https://platform.claude.com'
/** OAuth client id Claude Code registers its login under. */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
/** Manual redirect: the browser shows a code the operator pastes back (no localhost server). */
export const CLAUDE_MANUAL_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback'
/**
 * Subscription-account authorize endpoint: the consumer IdP backing
 * `claude login` (as opposed to the API-console endpoint used for
 * console-bound grants). Tokens minted here carry the subscription.
 */
export const CLAUDE_ACCOUNT_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'
/** Scopes the login requests: base pair plus the session/tool/upload set. */
export const CLAUDE_OAUTH_SCOPES: readonly string[] = Object.freeze([
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
])
/** Default credentials-seam reference holding the serialized OAuth state. */
export const DEFAULT_OAUTH_REF = 'CLAUDE_CODE_OAUTH'
/** Refresh-skew guard: treat tokens as expired this early. */
const EXPIRY_SKEW_MS = 5 * 60_000

/** Durable OAuth state: tokens plus the granted scopes. */
export interface ClaudeOAuthState {
  /** Bearer access token for inference (`sk-ant-oat01…`). */
  access: string
  /** Refresh token for silent renewal; absent when the grant omitted one. */
  refresh?: string
  /** Epoch milliseconds after which the access token must be refreshed. */
  expiresAt: number
}

/** Smallest credential-source surface the OAuth helpers need. */
export interface OAuthCredentialSource {
  /** Resolve one reference to its stored value, if present. */
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** Smallest credential-sink surface the login flow needs. */
export interface OAuthCredentialSink {
  /** Durably store one value under a reference. */
  set(ref: string, value: string): Promise<void>
}

/** Operator interaction for the one-time login; injected so tests drive fakes. */
export interface ClaudeLoginInteraction {
  /** Show a line to the operator (link, progress). Never receives secrets. */
  notify(message: string): void
  /** Read one pasted line (the browser code) from the operator. */
  promptLine(message: string): Promise<string>
  /** Fires with the approval link right after it builds, e.g. to open it. */
  onApproveLink?: (url: string) => void
  /** Cancellation for the waits. */
  signal?: AbortSignal | undefined
}

/** Narrow, named errors for the login flow (never carrying token material). */
export class ClaudeOAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ClaudeOAuthError'
  }
}

/** Parse durable OAuth state; `undefined` for anything absent or malformed. */
export function parseOAuthState(raw: string | undefined): ClaudeOAuthState | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.access !== 'string' || record.access.length === 0) return undefined
  if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) return undefined
  const state: ClaudeOAuthState = { access: record.access, expiresAt: record.expiresAt }
  if (typeof record.refresh === 'string' && record.refresh.length > 0) state.refresh = record.refresh
  return state
}

/** Whether the access token is still usable (with refresh skew applied). */
export function isAccessValid(state: ClaudeOAuthState, now: number = Date.now()): boolean {
  return state.expiresAt - EXPIRY_SKEW_MS > now
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Fresh PKCE pair: high-entropy verifier plus its S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(64))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Pending browser approval: the URL to open plus the secrets to complete it. */
export interface ClaudeAuthorizeFlow {
  /** Browser link the operator approves. */
  authorizeUrl: string
  /** PKCE verifier redeemed with the pasted code. */
  verifier: string
  /** Anti-forgery state echoed by the console. */
  state: string
}

/**
 * Build the browser approval URL and the secrets that redeem it. Pure over
 * injectable randomness so tests pin the exact URL.
 */
export function createAuthorizeFlow(options?: {
  authorizeUrl?: string
  clientId?: string
  scopes?: readonly string[]
  state?: string
  verifier?: string
  challenge?: string
}): ClaudeAuthorizeFlow {
  const pair = options?.verifier !== undefined && options.challenge !== undefined
    ? { verifier: options.verifier, challenge: options.challenge }
    : createPkcePair()
  const state = options?.state ?? base64Url(randomBytes(24))
  // Subscription inference needs the account IdP grant, not the
  // API-console one: same token endpoint, different approver.
  const url = options?.authorizeUrl !== undefined
    ? new URL(options.authorizeUrl)
    : new URL(CLAUDE_ACCOUNT_AUTHORIZE_URL)
  // The genuine client always sends `code=true` on the approval URL.
  url.searchParams.set('code', 'true')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', options?.clientId ?? CLAUDE_OAUTH_CLIENT_ID)
  url.searchParams.set('redirect_uri', CLAUDE_MANUAL_REDIRECT_URL)
  url.searchParams.set('scope', [...(options?.scopes ?? CLAUDE_OAUTH_SCOPES)].join(' '))
  url.searchParams.set('code_challenge', pair.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  return { authorizeUrl: url.href, verifier: pair.verifier, state }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ClaudeOAuthError(`Claude token endpoint answered without ${field}`)
  }
  return value
}

/** Redeem one pasted browser code for tokens. */
export async function exchangeCode(
  code: string,
  verifier: string,
  options?: {
    signal?: AbortSignal | undefined
    consoleBase?: string | undefined
    clientId?: string | undefined
    state?: string | undefined
  },
): Promise<{ access: string; refresh?: string; expiresAt: number }> {
  const base = options?.consoleBase ?? CLAUDE_CONSOLE_URL
  const response = await fetch(`${base}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_MANUAL_REDIRECT_URL,
      client_id: options?.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
      code_verifier: verifier,
      ...(options?.state === undefined ? {} : { state: options.state }),
    }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) {
    throw new ClaudeOAuthError(`Claude code exchange failed with HTTP ${response.status}`)
  }
  const payload: unknown = await response.json()
  if (!isRecord(payload) || typeof payload.access_token !== 'string') {
    const reason = isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'unknown'
    throw new ClaudeOAuthError(`Claude code exchange failed: ${reason}`)
  }
  const lifetime = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 3600
  const tokens: { access: string; refresh?: string; expiresAt: number } = {
    access: requiredString(payload, 'access_token'),
    expiresAt: Date.now() + lifetime * 1000 - EXPIRY_SKEW_MS,
  }
  if (typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0) {
    tokens.refresh = payload.refresh_token
  }
  return tokens
}

/** Renew an access token from its refresh token. */
export async function refreshAccessToken(state: ClaudeOAuthState, options?: {
  signal?: AbortSignal | undefined
  consoleBase?: string | undefined
  clientId?: string | undefined
  scopes?: readonly string[] | undefined
}): Promise<ClaudeOAuthState> {
  if (state.refresh === undefined) {
    throw new ClaudeOAuthError('Claude session has no refresh token; log in again')
  }
  const base = options?.consoleBase ?? CLAUDE_CONSOLE_URL
  let payload: unknown
  try {
    const response = await fetch(`${base}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: state.refresh,
        client_id: options?.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
        scope: [...(options?.scopes ?? CLAUDE_OAUTH_SCOPES)].join(' '),
      }).toString(),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    })
    if (!response.ok) throw new ClaudeOAuthError(`HTTP ${response.status}`)
    payload = await response.json() as unknown
  } catch (error: unknown) {
    throw new ClaudeOAuthError('Claude token refresh failed', { cause: error })
  }
  if (!isRecord(payload) || typeof payload.access_token !== 'string') {
    const reason = isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'unknown'
    throw new ClaudeOAuthError(`Claude token refresh failed: ${reason}`)
  }
  const lifetime = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 3600
  const next: ClaudeOAuthState = {
    access: payload.access_token,
    expiresAt: Date.now() + lifetime * 1000 - EXPIRY_SKEW_MS,
  }
  // A rotation replaces the stored token; otherwise the previous one stands.
  next.refresh = typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0
    ? payload.refresh_token
    : state.refresh
  return next
}

/**
 * Run the one-time interactive login: show the browser link, read the pasted
 * code, exchange it, and return the state to store. The caller persists the
 * result (credentials seam); this function never prints token material.
 */
export async function runClaudeLogin(interaction: ClaudeLoginInteraction, options?: {
  consoleBase?: string
  authorizeUrl?: string
  clientId?: string
  scopes?: readonly string[]
}): Promise<ClaudeOAuthState> {
  const flow = createAuthorizeFlow(options)
  interaction.onApproveLink?.(flow.authorizeUrl)
  interaction.notify(`Claude Code login: open ${flow.authorizeUrl} and paste the shown code here.`)
  const pasted = (await interaction.promptLine('Code: ')).trim()
  if (pasted.length === 0) throw new ClaudeOAuthError('Claude login cancelled: no code entered')
  if (interaction.signal?.aborted === true) throw new ClaudeOAuthError('Claude login cancelled')
  // The console returns `{code}#{state}`: redeem the code half, and refuse
  // a state that is not the one this flow minted.
  const hash = pasted.indexOf('#')
  const code = (hash === -1 ? pasted : pasted.slice(0, hash)).trim()
  const state = hash === -1 ? undefined : pasted.slice(hash + 1).trim()
  if (code.length === 0) throw new ClaudeOAuthError('Claude login failed: pasted code is empty')
  if (state !== undefined && state !== flow.state) {
    throw new ClaudeOAuthError('Claude login failed: the pasted code is not for this login attempt; start over')
  }
  return exchangeCode(code, flow.verifier, {
    signal: interaction.signal,
    state: state ?? flow.state,
    ...options,
  })
}
