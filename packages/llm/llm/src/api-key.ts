/**
 * Provider credentials are opaque; only blank values and HTTP header
 * serialization failures are diagnosed locally.
 * @module @deepseek-ai/dsh-llm/api-key
 */
import { validateHeaderValue } from 'node:http'

/** Why a supplied API key cannot be used. */
export type ApiKeyRejection = 'empty' | 'illegalCharacters'

/** The verdict on one supplied API key. */
export type ApiKeyCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ApiKeyRejection }

/**
 * Trim one supplied credential and check only HTTP header serialization.
 *
 * Prefix, length, quotes, assignment-like text, spaces and Latin-1 characters
 * are not provider-independent validity rules. The provider decides whether a
 * serializable credential authenticates. Absence remains the caller's
 * configuration decision; a supplied blank value is rejected here.
 * @param raw - the key exactly as configured, stored, or typed.
 * @returns the trimmed key, or why HTTP transport cannot use it.
 */
export function normalizeApiKey(raw: string): ApiKeyCheck {
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: 'empty' }
  try {
    validateHeaderValue('x-api-key', value)
  } catch (error) {
    // Transport diagnostics may contain credential data; expose only the reason.
    void error
    return { ok: false, reason: 'illegalCharacters' }
  }
  return { ok: true, value }
}
