import { createHmac, timingSafeEqual } from 'node:crypto'

export interface DisplayChallenge {
  requestId: string
  binding: string
  expiresAt: number
  summary: string
}

const MAX_PENDING = 16
const MAX_SKEW_MS = 30_000
const MAX_LIFETIME_MS = 90_000
const HEX_MAC = /^[a-f0-9]{64}$/
const HEX_NONCE = /^[a-f0-9]{32}$/

/** Domain-separated and length-prefixed, matching the Swift CryptoKit implementation. */
export function consentMac(key: Uint8Array, fields: readonly string[]): string {
  if (key.length !== 32) throw new RangeError('native consent seed must be 32 bytes')
  const hmac = createHmac('sha256', key)
  for (const value of fields) {
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    hmac.update(length).update(bytes)
  }
  return hmac.digest('hex')
}

export function displayChallengeMac(key: Uint8Array, challenge: DisplayChallenge): string {
  return consentMac(key, [
    'antonmail-display-v1', challenge.requestId, challenge.binding,
    String(challenge.expiresAt), challenge.summary,
  ])
}

function matches(expected: string, received: string): boolean {
  if (!HEX_MAC.test(received)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))
}

/** A private, bounded bridge inbox. Origin/loopback are not credentials. */
export class NativeChallengeInbox {
  private readonly pending = new Map<string, DisplayChallenge>()
  private readonly seen = new Map<string, number>()
  private readonly nativeNonces = new Map<string, number>()

  constructor(private readonly key: Uint8Array | undefined, private readonly now = Date.now) {}

  private prune(): void {
    const now = this.now()
    for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id)
    for (const [id, challenge] of this.pending) if (challenge.expiresAt <= now) this.pending.delete(id)
    for (const [nonce, expires] of this.nativeNonces) if (expires <= now) this.nativeNonces.delete(nonce)
  }

  accept(value: unknown): boolean {
    if (!this.key || !value || typeof value !== 'object' || Array.isArray(value)) return false
    const input = value as Record<string, unknown>
    const { requestId, binding, expiresAt, summary, mac } = input
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)
      || typeof binding !== 'string' || !/^[a-f0-9]{64}$/.test(binding)
      || typeof summary !== 'string' || !summary.trim() || Buffer.byteLength(summary) > 512
      || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)
      || typeof mac !== 'string' || !HEX_MAC.test(mac)) return false
    const now = this.now()
    if (expiresAt <= now || expiresAt > now + MAX_LIFETIME_MS) return false
    const challenge: DisplayChallenge = { requestId, binding, expiresAt, summary }
    if (!matches(displayChallengeMac(this.key, challenge), mac)) return false
    this.prune()
    if (this.seen.has(requestId) || this.pending.size >= MAX_PENDING || this.seen.size >= MAX_PENDING * 4) return false
    this.seen.set(requestId, expiresAt)
    this.pending.set(requestId, challenge)
    return true
  }

  /** One-use native poll; unauthorized/replayed requests cannot dequeue. */
  takeNative(timestamp: string, nonce: string, mac: string): DisplayChallenge | undefined {
    if (!this.key || !/^(0|[1-9][0-9]{0,15})$/.test(timestamp)
      || !HEX_NONCE.test(nonce) || !HEX_MAC.test(mac)) return undefined
    const when = Number(timestamp)
    if (!Number.isSafeInteger(when) || Math.abs(this.now() - when) > MAX_SKEW_MS) return undefined
    const expected = consentMac(this.key, ['antonmail-native-poll-v1', timestamp, nonce])
    if (!matches(expected, mac)) return undefined
    this.prune()
    if (this.nativeNonces.has(nonce) || this.nativeNonces.size >= MAX_PENDING * 4) return undefined
    this.nativeNonces.set(nonce, this.now() + MAX_SKEW_MS)
    const next = this.pending.entries().next().value as [string, DisplayChallenge] | undefined
    if (!next) return undefined
    this.pending.delete(next[0])
    return next[1]
  }
}
