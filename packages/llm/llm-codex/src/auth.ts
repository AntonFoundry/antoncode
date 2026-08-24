/**
 * Codex subscription authentication: reuse the OAuth login the Codex CLI or
 * VS Code Codex extension already holds (`~/.codex/auth.json`), refreshing
 * the access token through the OpenAI OAuth token endpoint with the stored
 * refresh token. There is deliberately NO API key anywhere in this module —
 * the plugin never prompts for one.
 *
 * @module dsh-llm-codex/auth
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The public Codex CLI OAuth client id; refresh grants must name it. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** OpenAI OAuth issuer. */
const OAUTH_ISSUER = 'https://auth.openai.com'
/** The token store's own live value for a ChatGPT-mode login. */
const CHATGPT_AUTH_MODE = 'chatgpt'

export interface CodexTokenSet {
  access_token: string
  refresh_token: string
  account_id?: string
}

export interface CodexAuthSnapshot {
  access_token: string
  refresh_token: string
  account_id?: string
  last_refresh?: string
}

interface AuthFileShape {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: Partial<CodexTokenSet>
  last_refresh?: string
  [key: string]: unknown
}

/** Base64url-decode one JWT segment without dependencies. */
function decodeJwtSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The access token's `exp` claim, when readable. */
function tokenExpiry(accessToken: string): number | undefined {
  const payload = decodeJwtSegment(accessToken.split('.')[1] ?? '')
  const exp = payload?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1_000 : undefined
}

/** Whether the access token is still valid (or its expiry is unreadable). */
function tokenUsable(accessToken: string | undefined): accessToken is string {
  if (typeof accessToken !== 'string' || accessToken.length === 0) return false
  const expiry = tokenExpiry(accessToken)
  // Unreadable expiry: treat as usable — the backend will 401 and we refresh.
  if (expiry === undefined) return true
  return Date.now() < expiry - 60_000
}

/**
 * Resolve the Codex home directory: $CODEX_HOME, else `~/.codex`.
 * @param codexHome - optional explicit override from plugin config.
 * @returns the resolved home path.
 */
export function codexHomeOf(codexHome: string | undefined): string {
  if (codexHome !== undefined && codexHome.trim() !== '') return codexHome.trim()
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
}

/**
 * Read the current auth snapshot without mutating anything. Throws
 * `MISSING_CREDENTIAL` when no ChatGPT-mode login exists.
 */
export async function readAuth(codexHome: string): Promise<CodexAuthSnapshot> {
  const authPath = join(codexHome, 'auth.json')
  let raw: string
  try {
    raw = await readFile(authPath, 'utf8')
  } catch {
    throw new LlmError(
      `No OpenAI Codex login found at ${authPath}. Log in once with the Codex CLI (\`codex login\`)`
      + ' or the VS Code Codex extension, then retry — no API key is needed.',
      'MISSING_CREDENTIAL',
    )
  }
  let parsed: AuthFileShape
  try {
    parsed = JSON.parse(raw) as AuthFileShape
  } catch {
    throw new LlmError(`Codex auth file at ${authPath} is not valid JSON`, 'MISSING_CREDENTIAL')
  }
  if (parsed.auth_mode !== undefined && parsed.auth_mode !== CHATGPT_AUTH_MODE) {
    throw new LlmError(
      `Codex auth at ${authPath} is in "${parsed.auth_mode}" mode; the Codex subscription provider`
      + ' requires a ChatGPT login (`codex login`, auth_mode "chatgpt").',
      'MISSING_CREDENTIAL',
    )
  }
  const tokens = parsed.tokens ?? {}
  if (!tokenUsable(tokens.access_token) && typeof tokens.refresh_token !== 'string') {
    throw new LlmError(
      `Codex auth at ${authPath} has neither a usable access token nor a refresh token.`
      + ' Re-run `codex login` and retry.',
      'MISSING_CREDENTIAL',
    )
  }
  return {
    access_token: tokens.access_token ?? '',
    refresh_token: tokens.refresh_token ?? '',
    ...typeof tokens.account_id === 'string' ? { account_id: tokens.account_id } : {},
    ...typeof parsed.last_refresh === 'string' ? { last_refresh: parsed.last_refresh } : {},
  }
}

/**
 * Refresh the access token through the OpenAI OAuth endpoint. The refresh
 * token was issued to the Codex CLI client id, so that client id is named on
 * the grant; the stored refresh token survives until OpenAI revokes it.
 */
export async function refreshToken(refreshToken: string): Promise<CodexTokenSet> {
  const response = await fetch(`${OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new LlmError(`OpenAI Codex token refresh failed (HTTP ${response.status})`, 'AUTH')
  }
  let payload: Record<string, unknown>
  try {
    payload = await response.json() as Record<string, unknown>
  } catch {
    throw new LlmError('OpenAI Codex token refresh returned an invalid response', 'AUTH')
  }
  const access = payload.access_token
  const nextRefresh = payload.refresh_token
  if (typeof access !== 'string' || access.length === 0) {
    throw new LlmError('OpenAI Codex token refresh returned no access token', 'AUTH')
  }
  return {
    access_token: access,
    refresh_token: typeof nextRefresh === 'string' ? nextRefresh : refreshToken,
    ...typeof payload.account_id === 'string' ? { account_id: payload.account_id } : {},
  }
}

/**
 * Persist refreshed tokens back into the shared auth file, preserving every
 * other field the Codex CLI owns. Written atomically (temp file + rename) so
 * a concurrent `codex` process never observes a torn file.
 */
async function writeAuth(codexHome: string, tokens: CodexTokenSet): Promise<void> {
  const authPath = join(codexHome, 'auth.json')
  let parsed: AuthFileShape
  try {
    parsed = JSON.parse(await readFile(authPath, 'utf8')) as AuthFileShape
  } catch {
    parsed = {}
  }
  const next: AuthFileShape = {
    ...parsed,
    auth_mode: parsed.auth_mode ?? CHATGPT_AUTH_MODE,
    tokens: { ...(parsed.tokens ?? {}), ...tokens },
    last_refresh: new Date().toISOString(),
  }
  const tempPath = `${authPath}.dsh-tmp`
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(tempPath, authPath)
}

/**
 * Resolve a usable access token for one request: read the shared Codex auth,
 * refreshing (and writing back) when the stored access token is expired.
 * @param codexHome - Codex home directory.
 * @returns the access token plus the account id for the `OpenAI-Account-Id` header.
 */
export async function resolveAccessToken(codexHome: string): Promise<CodexTokenSet> {
  const snapshot = await readAuth(codexHome)
  if (tokenUsable(snapshot.access_token)) {
    return {
      access_token: snapshot.access_token,
      refresh_token: snapshot.refresh_token,
      ...snapshot.account_id === undefined ? {} : { account_id: snapshot.account_id },
    }
  }
  if (snapshot.refresh_token.length === 0) {
    throw new LlmError('OpenAI Codex access token expired with no refresh token; re-run `codex login`.', 'AUTH')
  }
  const refreshed = await refreshToken(snapshot.refresh_token)
  await writeAuth(codexHome, refreshed).catch(() => {
    // A failed write-back never fails the request — the in-memory token is
    // still valid for this call and the next refresh will retry.
  })
  return {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    ...snapshot.account_id !== undefined ? { account_id: snapshot.account_id } : {},
  }
}
