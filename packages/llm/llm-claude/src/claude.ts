/**
 * Claude Code subscription facts: endpoint, credential reference, and the
 * per-request session resolution (valid token, silent refresh, fail loud).
 * Inference itself rides pi-ai's Anthropic implementation, which already
 * keys Claude Code identity (`Bearer` + `oauth-2025-04-20` beta) off the
 * `sk-ant-oat` token family — so this module carries auth only, never wire
 * code.
 *
 * @module dsh-llm-claude/claude
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  DEFAULT_OAUTH_REF,
  isAccessValid,
  parseOAuthState,
  refreshAccessToken,
  type ClaudeOAuthState,
} from './claude-oauth.ts'

/** Anthropic API root serving subscription inference. */
export const CLAUDE_BASE_URL = 'https://api.anthropic.com'
/** Default credentials-seam reference holding the serialized OAuth state. */
export const CLAUDE_OAUTH_ENV = DEFAULT_OAUTH_REF
/** Installed-catalog provider id backing the `claude-code` route's models. */
export const CLAUDE_CATALOG_PROVIDER = 'anthropic'

/** Smallest credential-source surface session resolution needs. */
export interface ClaudeCredentialSource {
  /** Resolve one reference to its stored value, if present. */
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
}

/** Smallest credential-sink surface token renewal needs. */
export interface ClaudeCredentialSink {
  /** Durably store one value under a reference. */
  set(ref: CredentialRef, value: string): Promise<void>
}

/**
 * Resolve one request's bearer token: the valid stored access token, else a
 * silent refresh (persisted for the next request), else `undefined` so the
 * caller fails loud with the login fix instead of sending nothing.
 * @param ref - credential reference holding serialized OAuth state.
 * @param source - credential reader; omission reads the process environment.
 * @param sink - optional writer for renewed state; omission leaves renewal unpersisted.
 * @returns a valid bearer token, or undefined when state lookup or renewal fails.
 */
export async function resolveClaudeAccess(
  ref: CredentialRef,
  source: ClaudeCredentialSource | undefined,
  sink: ClaudeCredentialSink | undefined,
): Promise<string | undefined> {
  let raw: string | undefined
  try {
    raw = source !== undefined ? (await source.resolve(ref))?.value : process.env[ref]
  } catch {
    return undefined
  }
  const state: ClaudeOAuthState | undefined = parseOAuthState(raw)
  if (state === undefined) return undefined
  if (isAccessValid(state)) return state.access
  let next: ClaudeOAuthState
  try {
    next = await refreshAccessToken(state, { signal: AbortSignal.timeout(30_000) })
  } catch {
    return undefined
  }
  if (sink !== undefined) {
    await sink.set(ref, JSON.stringify(next)).catch(() => {})
  }
  return next.access
}
