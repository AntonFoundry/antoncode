import { createHmac } from 'node:crypto'

export interface NativeDisplayChallenge {
  readonly requestId: string
  readonly binding: string
  readonly expiresAt: number
  readonly summary: string
}

/** Native bridge MAC contract: length-prefixed UTF-8 fields, SHA-256 hex. */
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

/** Authenticated localhost handoff; a rejected/unreachable native display denies pairing. */
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
