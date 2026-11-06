/** Authenticated native-display handoff for Agent mail consent challenges. */
import { createHmac } from 'node:crypto'

/** Challenge facts and human-readable summary authenticated for the native bridge display. */
export interface NativeDisplayChallenge {
  readonly requestId: string
  readonly binding: string
  readonly expiresAt: number
  readonly summary: string
}

/**
 * Authenticate length-prefixed UTF-8 challenge fields for the native bridge.
 * @param key - 32-byte native consent seed; any other length throws RangeError.
 * @param challenge - exact challenge and summary to display.
 * @returns SHA-256 HMAC as lowercase hexadecimal text.
 */
export function nativeDisplayMac(key: Uint8Array, challenge: NativeDisplayChallenge): string {
  if (key.length !== 32) throw new RangeError('native consent seed must have 32 bytes')
  const hmac = createHmac('sha256', key)
  for (const field of ['antonmail-display-v1', challenge.requestId, challenge.binding,
    String(challenge.expiresAt), challenge.summary]) {
    const bytes = Buffer.from(field, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    hmac.update(length).update(bytes)
  }
  return hmac.digest('hex')
}

/**
 * Send an authenticated challenge to the localhost native bridge with a two-second request timeout.
 * @param key - native consent seed used to authenticate the challenge.
 * @param challenge - challenge with a nonblank summary of at most 512 UTF-8 bytes.
 * @param transport - HTTP transport; defaults to fetch.
 * @returns whether the bridge returned a successful HTTP status; false for invalid summary or any handoff error.
 */
export async function deliverNativeChallenge(
  key: Uint8Array,
  challenge: NativeDisplayChallenge,
  transport: typeof fetch = fetch,
): Promise<boolean> {
  if (Buffer.byteLength(challenge.summary, 'utf8') > 512 || challenge.summary.trim() === '') return false
  try {
    const response = await transport('http://127.0.0.1:3742/bridge/api/mail/challenge', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...challenge, mac: nativeDisplayMac(key, challenge) }),
      signal: AbortSignal.timeout(2_000),
    })
    return response.ok
  } catch { return false }
}
