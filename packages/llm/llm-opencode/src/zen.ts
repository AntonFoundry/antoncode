/**
 * Direct OpenCode Zen transport facts: the gateway base, the anonymous
 * credential, the OpenCode client-identity headers, and the per-request key
 * resolution shared by the direct adapter and the route's transport picker.
 *
 * Authentication is the bearer key alone (`OPENCODE_API_KEY`, else the
 * literal `public` anonymous credential, exactly as OpenCode's own provider
 * falls back). The `x-opencode-*` headers are client/request identity, not
 * authentication: the session id is required (the gateway answers
 * `MissingSessionID` without one), and the request id correlates quota.
 * Harness omits `x-opencode-project` — it has no OpenCode project id — just
 * as OpenCode omits it when no project is available.
 *
 * @module dsh-llm-opencode/zen
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** OpenCode Zen gateway base; `/chat/completions` and `/responses` are appended. */
export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
/** The literal anonymous key the Zen gateway accepts for its free tier. */
export const ZEN_ANONYMOUS_KEY = 'public'
/** Default credential reference naming the Zen bearer key. */
export const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY'
/** models.dev provider id whose free tier the direct transport serves. */
export const ZEN_CATALOG_PROVIDER = 'opencode'
/** Session-id fallback for a request that carries no conversation session. */
const fallbackSessionId = randomUUID()

/**
 * Build the Zen client-identity headers for one request, mirroring OpenCode's
 * `packages/opencode/src/session/llm/request.ts` session/request/client
 * headers with real Harness identifiers — never fixed ids. The User-Agent
 * stays Harness-honest (`opencode/harness`); the transport prefixes the
 * mandatory Harness attribution after these extras.
 * @param sessionId - the conversation session id, or `undefined` for the process fallback.
 * @param requestId - the latest user message id, or `undefined` for a generated fallback.
 * @returns the headers for this one request.
 */
export function resolveZenHeaders(
  sessionId: string | undefined,
  requestId?: string,
): Record<string, string> {
  const session = sessionId ?? fallbackSessionId
  const request = requestId ?? `msg_${randomUUID()}`
  const client = process.env.OPENCODE_CLIENT ?? 'cli'
  return {
    'x-opencode-session-id': session,
    'x-opencode-session': session,
    'x-opencode-request': request,
    'x-opencode-client': client,
    'user-agent': 'opencode/harness',
  }
}

/** Minimal credential source: what `ctx.get('credentials')` offers, or `undefined` without the seam. */
export interface ZenCredentialSource {
  /** Resolve one credential reference to its stored value, if present. */
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
}

/**
 * Resolve a real Zen bearer key, or `undefined` when no credential is stored
 * anywhere. Never returns the anonymous key — the caller decides whether
 * anonymous direct (the gateway's verdict, currently a free-tier rejection
 * for non-OpenCode TLS stacks) or the local-service fallback serves.
 */
export async function resolveRealKey(
  ref: CredentialRef,
  credentials: ZenCredentialSource | undefined,
): Promise<string | undefined> {
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-opencode', ref)
  } else {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) {
      return assertUsableApiKey(ambient, 'llm-opencode', ref)
    }
  }
  return undefined
}

/**
 * Resolve the direct transport's bearer key: the stored credential, or the
 * anonymous literal when none is stored.
 */
export async function resolveZenApiKey(
  ref: CredentialRef,
  credentials: ZenCredentialSource | undefined,
): Promise<string> {
  return (await resolveRealKey(ref, credentials)) ?? ZEN_ANONYMOUS_KEY
}
