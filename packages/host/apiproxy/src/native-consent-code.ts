import { createHmac, timingSafeEqual } from 'node:crypto'

/** Protocol v1 is shared by the Host verifier and the native display. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MAX_ATTEMPTS = 5
const LIFETIME_MS = 90_000

export interface ConsentChallenge {
  readonly requestId: string
  readonly binding: string
  readonly expiresAt: number
}

/** Length-prefix each field: concatenated variable-length identifiers are ambiguous. */
export function nativeConsentCode(key: Uint8Array, challenge: ConsentChallenge): string {
  if (key.length !== 32) throw new RangeError('native consent requires a 32-byte seed')
  const fields = ['antonmail-code-v1', challenge.requestId, challenge.binding, String(challenge.expiresAt)]
  const hmac = createHmac('sha256', key)
  for (const value of fields) {
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    hmac.update(length).update(bytes)
  }
  const digest = hmac.digest()
  let bits = 0n
  for (let index = 0; index < 5; index += 1) bits = (bits << 8n) | BigInt(digest[index] ?? 0)
  let code = ''
  for (let index = 7; index >= 0; index -= 1) code += ALPHABET[Number((bits >> BigInt(index * 5)) & 31n)]
  return code
}

interface PendingConsent {
  challenge: ConsentChallenge
  attempts: number
}

/** Volatile, one-use verification; no browser route may read the expected code. */
export class NativeConsentVerifier {
  private readonly pending = new Map<string, PendingConsent>()
  constructor(private readonly key: Uint8Array | undefined, private readonly now = Date.now) {
    if (key !== undefined && key.length !== 32) throw new RangeError('native consent requires a 32-byte seed')
  }

  issue(challenge: ConsentChallenge): boolean {
    if (!this.key || !challenge.requestId || !challenge.binding || !Number.isSafeInteger(challenge.expiresAt)
      || challenge.expiresAt <= this.now() || challenge.expiresAt > this.now() + LIFETIME_MS
      || this.pending.has(challenge.requestId)) return false
    this.pending.set(challenge.requestId, { challenge, attempts: 0 })
    return true
  }

  revoke(requestId: string): void { this.pending.delete(requestId) }
  revokeAll(): void { this.pending.clear() }

  verify(requestId: string, submittedCode: string): boolean {
    const pending = this.pending.get(requestId)
    if (!pending || !this.key) return false
    if (pending.challenge.expiresAt <= this.now() || pending.attempts >= MAX_ATTEMPTS) {
      this.pending.delete(requestId)
      return false
    }
    pending.attempts += 1
    // Validate before allocating or comparing: this method is reachable from
    // an untrusted client once the consent transport is mounted.
    if (typeof submittedCode !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{8}$/i.test(submittedCode)) {
      if (pending.attempts >= MAX_ATTEMPTS) this.pending.delete(requestId)
      return false
    }
    const submitted = Buffer.from(submittedCode.toUpperCase(), 'ascii')
    const expected = Buffer.from(nativeConsentCode(this.key, pending.challenge), 'ascii')
    const valid = timingSafeEqual(submitted, expected)
    if (valid || pending.attempts >= MAX_ATTEMPTS) this.pending.delete(requestId)
    return valid
  }
}
