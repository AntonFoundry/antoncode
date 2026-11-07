/**
 * Optional LAN exposure for the bridge.
 *
 * The desktop surface is loopback-only by construction: the bridge binds
 * `127.0.0.1`, rejects any other Host authority, and proxies the app to a
 * harness that is itself loopback-bound. Enabling LAN access keeps the harness
 * private — every remote request is relayed through this bridge — and adds one
 * gate in front of the relay: a shared token, presented once as `?token=` and
 * carried afterwards in an HttpOnly cookie. Desktop-only routes stay local.
 */
import { createHash, timingSafeEqual } from 'node:crypto'

/** Cookie carrying an accepted LAN token. */
export const LAN_COOKIE = 'anton_bridge_lan'
/** Shortest accepted token; shorter secrets are guessable on a shared network. */
export const LAN_TOKEN_MIN_LENGTH = 16
/** Every authority that means "this machine"; these are never gated. */
const LOOPBACK_AUTHORITIES = new Set(['127.0.0.1', 'localhost', 'antoncode.localhost', '[::1]', '::1', '::ffff:127.0.0.1'])

/** Validated LAN exposure settings for one bridge process. */
export interface LanAccess {
  /** Whether the bridge binds every interface instead of loopback. */
  enabled: boolean
  /**
   * Shared secret a non-loopback client must present. Empty when access is
   * disabled; never empty when {@link enabled} is true.
   */
  token: string
}

/**
 * Parse the LAN settings from a config document and the environment.
 *
 * The environment wins over the document, matching the bridge's other
 * settings. Enabling access without a usable token throws instead of binding
 * an unauthenticated door to every interface.
 * @param document - parsed `bridge.json` value, or any non-object for none.
 * @param env - environment variables; omitted reads `process.env`.
 * @returns the validated settings.
 * @throws when access is enabled without a token of {@link LAN_TOKEN_MIN_LENGTH}.
 */
export function readLanAccess(
  document: unknown,
  env: Record<string, string | undefined> = process.env,
): LanAccess {
  const source = typeof document === 'object' && document !== null && !Array.isArray(document)
    ? (document as { lanAccess?: { enabled?: unknown; token?: unknown } }).lanAccess
    : undefined
  const enabledFlag = env.ANTON_BRIDGE_LAN ?? (typeof source?.enabled === 'boolean' ? String(source.enabled) : '')
  const enabled = enabledFlag === 'true' || enabledFlag === '1'
  const rawToken = env.ANTON_BRIDGE_LAN_TOKEN ?? (typeof source?.token === 'string' ? source.token : '')
  const token = rawToken.trim()
  if (!enabled) return { enabled: false, token: '' }
  if (token.length < LAN_TOKEN_MIN_LENGTH) {
    throw new Error(`LAN access needs a token of at least ${LAN_TOKEN_MIN_LENGTH} characters (ANTON_BRIDGE_LAN_TOKEN)`)
  }
  return { enabled: true, token }
}

/**
 * Whether one URL hostname is this machine's own authority.
 * @param hostname - hostname from a parsed request URL.
 * @returns true for loopback names and addresses.
 */
export function isLoopbackAuthority(hostname: string): boolean {
  return LOOPBACK_AUTHORITIES.has(hostname.toLowerCase())
}

/**
 * Compare two secrets without leaking their difference through timing.
 * Both sides are hashed first so unequal lengths take the same path.
 * @param presented - value the client supplied.
 * @param expected - configured token.
 * @returns true when they are equal.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  if (expected === '') return false
  const left = createHash('sha256').update(presented).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

/**
 * `Set-Cookie` value that carries an accepted token to the browser.
 * @param token - validated LAN token.
 * @returns the header value; `HttpOnly` keeps it away from page scripts and
 * `SameSite=Lax` keeps a cross-site page from riding it.
 */
export function lanCookie(token: string): string {
  return `${LAN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
}

/**
 * Read the LAN token from a request's cookie header.
 * @param cookieHeader - raw `cookie` request header, or null.
 * @returns the presented token, or '' when absent or malformed.
 */
export function lanTokenFromCookies(cookieHeader: string | null): string {
  if (cookieHeader === null) return ''
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== LAN_COOKIE) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return ''
    }
  }
  return ''
}

/** Outcome of the LAN gate for one request. */
export type LanDecision =
  /** Loopback client, or LAN access disabled: unchanged desktop behaviour. */
  | { kind: 'local' }
  /** Non-loopback client that proved the token with its cookie. */
  | { kind: 'granted' }
  /** Non-loopback client that proved the token in the query; answer with the cookie. */
  | { kind: 'challenge' }
  /** Non-loopback client with no usable token, or LAN access disabled. */
  | { kind: 'denied' }

/**
 * Decide what one request may do, before any routing.
 *
 * A query token is accepted only on a navigation (`GET`/`HEAD`), which is what
 * a browser sends for the first visit; every other method must already carry
 * the cookie, so a link with `?token=` cannot become a write primitive.
 * @param request - the incoming request.
 * @param access - validated LAN settings.
 * @returns the decision; callers answer `denied` with 404 and `challenge` with
 * a redirect that drops the token from the URL and sets the cookie.
 */
export function lanDecision(request: Request, access: LanAccess): LanDecision {
  if (isLoopbackAuthority(new URL(request.url).hostname)) return { kind: 'local' }
  if (!access.enabled) return { kind: 'denied' }
  if (tokensMatch(lanTokenFromCookies(request.headers.get('cookie')), access.token)) return { kind: 'granted' }
  const method = request.method
  if (method === 'GET' || method === 'HEAD') {
    const presented = new URL(request.url).searchParams.get('token') ?? ''
    if (tokensMatch(presented, access.token)) return { kind: 'challenge' }
  }
  return { kind: 'denied' }
}

/**
 * Paths that belong to the desktop surface and never leave this machine.
 * @param pathname - request path.
 * @returns true for the control page and every control API.
 */
export function isDesktopPath(pathname: string): boolean {
  return pathname === '/bridge' || pathname.startsWith('/bridge/')
}

/**
 * Redirect that trades a query token for the cookie.
 * @param request - the challenge request that carried `?token=`.
 * @param access - validated LAN settings.
 * @returns a 303 to the same URL without the token, carrying the cookie.
 */
export function lanChallengeResponse(request: Request, access: LanAccess): Response {
  const target = new URL(request.url)
  target.searchParams.delete('token')
  return new Response(null, {
    status: 303,
    headers: {
      location: `${target.pathname}${target.search}`,
      'set-cookie': lanCookie(access.token),
      'cache-control': 'no-store',
    },
  })
}
