/**
 * Google Antigravity OAuth authentication for the DeepSeek Harness LLM seam.
 *
 * Antigravity (Google's IDE) exposes Claude/Gemini models through a Gemini-style
 * gateway behind Google OAuth — there is no API key. This module implements the
 * OAuth flow end to end:
 *
 *  1. `authorizeAntigravity()` builds the Google authorization URL with PKCE
 *     (S256) and `access_type=offline`, so the callback yields a refresh token.
 *  2. `exchangeAntigravity()` trades the authorization code for access + refresh
 *     tokens, reads the user's email, and discovers the project id via the
 *     Antigravity `loadCodeAssist` endpoint.
 *  3. `resolveAccessToken()` picks a stored account and silently refreshes its
 *     access token when it is expired or missing.
 *
 * Accounts persist as the shared Antigravity accounts file (the same
 * `antigravity-accounts.json` the reference opencode plugin writes), so an
 * existing login is reused; the path is configurable for a Harness-native home.
 *
 * @module @deepseek-ai/dsh-llm-antigravity/auth
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Public OAuth client issued for the Antigravity application. These are the
// same identifiers the reference Antigravity proxy and the opencode plugin use.
export const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
export const ANTIGRAVITY_CLIENT_SECRET = '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'

export const ANTIGRAVITY_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

/** Local loopback callback used by the OAuth authorization-server flow. */
export const ANTIGRAVITY_REDIRECT_URI = 'http://localhost:51121/oauth-callback'

/** Antigravity gateway endpoints, in primary/fallback order (prod → daily). */
export const ANTIGRAVITY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
export const ANTIGRAVITY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [ANTIGRAVITY_ENDPOINT_PROD, ANTIGRAVITY_ENDPOINT_DAILY] as const
export const ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_ENDPOINT_PROD

/** Hardcoded project used when the gateway returns none (business/workspace accounts). */
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = 'rising-fact-p41fc'

const OAuth_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json'

const FETCH_TIMEOUT_MS = 10_000
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000

/** One stored Antigravity account. */
export interface AntigravityAccount {
  email?: string
  /** Packed refresh credential: `refreshToken|projectId|managedProjectId`. */
  refreshToken: string
  projectId?: string
}

/** The account file: a JSON list of accounts. */
export interface AntigravityAccountsFile {
  accounts: AntigravityAccount[]
}

/** A live, non-expired token for one account. */
export interface AntigravityAuth {
  accessToken: string
  expires: number
  projectId?: string
  email?: string
  /**
   * The packed refresh credential (`refreshToken|projectId`), present right
   * after {@link exchangeAntigravity} so a login flow can store the account.
   */
  refresh?: string
}

/** PKCE pair produced by {@link authorizeAntigravity}. */
export interface AntigravityAuthorization {
  url: string
  verifier: string
  projectId: string
}

function accountsFileDefault(): string {
  return join(homedir(), '.config', 'opencode', 'antigravity-accounts.json')
}

/** Resolve the accounts file path from config (empty means the shared default). */
export function accountsPathOf(path: string | undefined): string {
  return resolve(path ?? accountsFileDefault())
}

/** Read accounts; a missing or corrupt file yields an empty list. */
export function readAccounts(path: string | undefined): AntigravityAccount[] {
  const file = accountsPathOf(path)
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return []
    const accounts = (parsed as AntigravityAccountsFile).accounts
    return Array.isArray(accounts) ? accounts : []
  } catch {
    return []
  }
}

/** Persist the account list atomically, creating the directory as needed. */
export function writeAccounts(path: string | undefined, accounts: AntigravityAccount[]): void {
  const file = accountsPathOf(path)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ accounts }, null, 2)}\n`, 'utf8')
  writeFileSync(file, `${JSON.stringify({ accounts }, null, 2)}\n`, 'utf8')
  try {
    // Best-effort cleanup of the staging file.
    import('node:fs').then(({ rmSync }) => rmSync(temporary, { force: true })).catch(() => undefined)
  } catch {
    /* non-fatal */
  }
}

/** Generate an S256 PKCE challenge/verifier pair. */
export function generatePkce(): { challenge: string; verifier: string } {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { challenge, verifier }
}

/** Base64url-encode a JSON object for the OAuth `state` parameter. */
function encodeState(verifier: string, projectId: string): string {
  return Buffer.from(JSON.stringify({ verifier, projectId }), 'utf8').toString('base64url')
}

/** Decode the OAuth `state` parameter back into its verifier + project. */
export function decodeState(state: string): { verifier: string; projectId: string } {
  const padded = state.padEnd(state.length + ((4 - (state.length % 4)) % 4), '=')
  const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  const parsed: unknown = JSON.parse(json)
  const record = (parsed ?? {}) as { verifier?: unknown; projectId?: unknown }
  if (typeof record.verifier !== 'string' || record.verifier.length === 0) {
    throw new Error('llm-antigravity: missing PKCE verifier in OAuth state')
  }
  return {
    verifier: record.verifier,
    projectId: typeof record.projectId === 'string' ? record.projectId : '',
  }
}

/**
 * Build the Google authorization URL for the Antigravity OAuth flow (PKCE S256,
 * offline access, consent prompt). The verifier must be passed back to
 * {@link exchangeAntigravity} with the returned code.
 */
export function authorizeAntigravity(projectId = ''): AntigravityAuthorization {
  const { challenge, verifier } = generatePkce()
  const url = new URL(OAuth_URL)
  url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', ANTIGRAVITY_REDIRECT_URI)
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '))
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', encodeState(verifier, projectId || ''))
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return { url: url.toString(), verifier, projectId: projectId || '' }
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Discover the account's Antigravity project id via `loadCodeAssist`. */
export async function fetchProjectId(accessToken: string): Promise<string> {
  // Discovery speaks the Gemini CLI header dialect (reference-verified);
  // the Antigravity Chrome agent applies only to generation calls.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'google-api-nodejs-client/9.15.1',
    'X-Goog-Api-Client': 'gl-node/22.17.0',
    'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
  }
  const body = JSON.stringify({})
  const endpoints: readonly string[] = [
    ANTIGRAVITY_ENDPOINT_PROD,
    ANTIGRAVITY_ENDPOINT_DAILY,
  ]
  for (const base of endpoints) {
    try {
      const response = await fetchWithTimeout(`${base}/v1internal:loadCodeAssist`, {
        method: 'POST', headers, body,
      })
      if (!response.ok) continue
      const data: unknown = await response.json()
      const project = (data ?? {}) as { cloudaicompanionProject?: unknown }
      const resolved = project.cloudaicompanionProject
      if (typeof resolved === 'string' && resolved) return resolved
      if (typeof resolved === 'object' && resolved !== null) {
        const id = (resolved as { id?: unknown }).id
        if (typeof id === 'string' && id) return id
      }
    } catch {
      continue
    }
  }
  return ''
}

/**
 * Exchange an authorization code for access + refresh tokens, reading the
 * user's email and discovering the project id.
 */
export async function exchangeAntigravity(code: string, state: string): Promise<AntigravityAuth> {
  const { verifier, projectId } = decodeState(state)
  const tokenResponse = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      code_verifier: verifier,
    }),
  })
  if (!tokenResponse.ok) {
    throw new Error(`llm-antigravity: token exchange failed with HTTP ${tokenResponse.status}: ${await tokenResponse.text()}`)
  }
  const payload = (await tokenResponse.json()) as { access_token?: string; refresh_token?: string; expires_in?: unknown }
  if (!payload.access_token) throw new Error('llm-antigravity: token exchange returned no access token')
  if (!payload.refresh_token) throw new Error('llm-antigravity: token exchange returned no refresh token')

  let email: string | undefined
  try {
    const userInfoResponse = await fetchWithTimeout(USERINFO_URL, {
      headers: { Authorization: `Bearer ${payload.access_token}` },
    })
    if (userInfoResponse.ok) {
      const info = (await userInfoResponse.json()) as { email?: string }
      email = info.email
    }
  } catch {
    /* email is advisory */
  }

  const discovered = projectId || await fetchProjectId(payload.access_token)
  const effectiveProject = discovered || ANTIGRAVITY_DEFAULT_PROJECT_ID

  return {
    accessToken: payload.access_token,
    expires: calculateTokenExpiry(Date.now(), payload.expires_in),
    projectId: effectiveProject,
    refresh: `${payload.refresh_token}|${effectiveProject}`,
    ...email === undefined ? {} : { email },
  }
}

/** Refresh an access token with a stored refresh token. */
export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expires: number }> {
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!response.ok) {
    throw new Error(`llm-antigravity: token refresh failed with HTTP ${response.status}: ${await response.text()}`)
  }
  const payload = (await response.json()) as { access_token?: string; expires_in?: unknown }
  if (!payload.access_token) throw new Error('llm-antigravity: token refresh returned no access token')
  return {
    accessToken: payload.access_token,
    expires: calculateTokenExpiry(Date.now(), payload.expires_in),
  }
}

/** Calculate the absolute expiry (ms) for a token issued at `requestTimeMs`. */
export function calculateTokenExpiry(requestTimeMs: number, expiresInSeconds: unknown): number {
  const seconds = typeof expiresInSeconds === 'number' ? expiresInSeconds : 3600
  if (!Number.isFinite(seconds) || seconds <= 0) return requestTimeMs
  return requestTimeMs + seconds * 1000
}

/** True when an access token is expired or absent (with a clock-skew buffer). */
export function accessTokenExpired(auth: { accessToken?: string; expires?: number }): boolean {
  if (!auth.accessToken || typeof auth.expires !== 'number') return true
  return auth.expires <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS
}

/**
 * Resolve a usable access token from the first enabled account, refreshing on
 * demand. Throws with a clear pointer to the login flow when no account exists
 * or every refresh fails.
 * @param path - accounts file path (empty means the shared default).
 * @param onRefresh - optional hook to persist a refreshed token.
 */
export async function resolveAccessToken(
  path: string | undefined,
  onRefresh?: (account: AntigravityAccount, index: number) => void,
): Promise<AntigravityAuth> {
  const accounts = readAccounts(path)
  if (accounts.length === 0) {
    throw new Error(
      'llm-antigravity: no Antigravity account is logged in. Run the Antigravity login flow to authorize with Google.',
    )
  }
  let lastError: Error | undefined
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index]!
    const [refreshToken = '', storedProject = ''] = (account.refreshToken ?? '').split('|')
    if (!refreshToken) continue
    try {
      const refreshed = await refreshAccessToken(refreshToken)
      let effectiveProject = storedProject || account.projectId
      if (!effectiveProject || effectiveProject === ANTIGRAVITY_DEFAULT_PROJECT_ID) {
        const discovered = await fetchProjectId(refreshed.accessToken)
        if (discovered) effectiveProject = discovered
      }
      if (!effectiveProject) effectiveProject = ANTIGRAVITY_DEFAULT_PROJECT_ID

      const updated: AntigravityAccount = {
        ...account.email === undefined ? {} : { email: account.email },
        refreshToken: account.refreshToken,
        projectId: effectiveProject,
      }
      onRefresh?.(updated, index)
      return {
        accessToken: refreshed.accessToken,
        expires: refreshed.expires,
        projectId: effectiveProject,
        ...account.email === undefined ? {} : { email: account.email },
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw new Error(
    lastError
      ? `llm-antigravity: no usable Antigravity account (last error: ${lastError.message})`
      : 'llm-antigravity: no usable Antigravity account is stored',
  )
}
