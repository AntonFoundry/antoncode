/** Shared native consent code derivation and process-local, attempt-limited challenge verification. */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Protocol v1 is shared by the Host verifier and the native display. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MAX_ATTEMPTS = 5
const LIFETIME_MS = 90_000

/** Request identity, action binding, and expiry authenticated together by the native consent code. */
export interface ConsentChallenge {
  readonly requestId: string
  readonly binding: string
  readonly expiresAt: number
}

/**
 * Derive a native display code from length-prefixed challenge fields.
 * @param key - 32-byte native seed; any other length throws RangeError.
 * @param challenge - request identity, action binding, and expiry to authenticate.
 * @returns eight-character code from the protocol alphabet, derived from the HMAC's first 40 bits.
 */
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

  /**
   * Retain a challenge for one successful verification with at most five attempts.
   * @param challenge - nonempty request identity and binding with a safe-integer expiry within 90 seconds.
   * @returns whether the challenge was registered; false for a missing seed, invalid expiry, or duplicate identity.
   */
  issue(challenge: ConsentChallenge): boolean {
    if (!this.key || !challenge.requestId || !challenge.binding || !Number.isSafeInteger(challenge.expiresAt)
      || challenge.expiresAt <= this.now() || challenge.expiresAt > this.now() + LIFETIME_MS
      || this.pending.has(challenge.requestId)) return false
    this.pending.set(challenge.requestId, { challenge, attempts: 0 })
    return true
  }

  /**
   * Remove a pending challenge; an unknown identity is a no-op.
   * @param requestId - challenge to revoke.
   */
  revoke(requestId: string): void { this.pending.delete(requestId) }
  /** Remove every pending challenge and its attempt count. */
  revokeAll(): void { this.pending.clear() }

  /**
   * Compare a case-insensitive code, consuming one attempt even when its format is invalid.
   * Successful verification, expiry, or the fifth failed attempt removes the challenge.
   * @param requestId - pending challenge identity.
   * @param submittedCode - eight-character code from the native display.
   * @returns whether the unexpired challenge code matched; false for missing or exhausted challenges.
   */
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
