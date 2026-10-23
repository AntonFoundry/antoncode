import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { consentMac, displayChallengeMac, NativeChallengeInbox } from '../src/consent-challenges.ts'

const seed = randomBytes(32)

it('matches the Host and native length-prefixed challenge MAC vector', () => {
  const vectorSeed = Buffer.alloc(32, 1)
  const vector = {
    requestId: 'request-vector-01', binding: 'a'.repeat(64),
    expiresAt: 1_792_747_500_000, summary: 'Send to Alice',
  }
  expect(displayChallengeMac(vectorSeed, vector)).toBe(
    '2d391c13c79d0bc8fc4793f7237c245ef6004da9b409f05fe87c14b3597416b1',
  )
})

const now = 1_000_000
const challenge = {
  requestId: 'request-012345', binding: 'a'.repeat(64), expiresAt: now + 60_000,
  summary: 'Send one message to recipient',
}
const signed = { ...challenge, mac: displayChallengeMac(seed, challenge) }
const proof = (nonce = 'b'.repeat(32)) => ({
  time: String(now), nonce,
  mac: consentMac(seed, ['antonmail-native-poll-v1', String(now), nonce]),
})

it('only a valid Host signature may enqueue, and only a signed native poll may read', () => {
  const inbox = new NativeChallengeInbox(seed, () => now)
  expect(inbox.accept({ ...signed, summary: 'Changed' })).toBe(false)
  expect(inbox.accept({ ...signed, mac: '0'.repeat(64) })).toBe(false)
  expect(inbox.accept(signed)).toBe(true)
  expect(inbox.accept(signed)).toBe(false)
  expect(inbox.takeNative(String(now), 'b'.repeat(32), '0'.repeat(64))).toBeUndefined()
  const { time, nonce, mac } = proof()
  expect(inbox.takeNative(time, nonce, mac)).toEqual(challenge)
  expect(inbox.takeNative(time, nonce, mac)).toBeUndefined()
})

it('rejects expired, future, malformed, and oversized challenges', () => {
  const inbox = new NativeChallengeInbox(seed, () => now)
  expect(inbox.accept({ ...signed, expiresAt: now - 1 })).toBe(false)
  expect(inbox.accept({ ...signed, expiresAt: now + 90_001 })).toBe(false)
  expect(inbox.accept({ ...signed, summary: 'x'.repeat(513) })).toBe(false)
  expect(inbox.accept({ ...signed, requestId: 'short' })).toBe(false)
  expect(inbox.accept({ ...signed, binding: 'bad' })).toBe(false)
  expect(new NativeChallengeInbox(undefined, () => now).accept(signed)).toBe(false)
})

it('rejects native clock skew, nonce replay, and absent seed', () => {
  const inbox = new NativeChallengeInbox(seed, () => now)
  inbox.accept(signed)
  const { time, nonce, mac } = proof()
  expect(inbox.takeNative(String(now - 30_001), nonce, mac)).toBeUndefined()
  expect(inbox.takeNative(time, nonce, mac)).toEqual(challenge)
  expect(inbox.takeNative(time, nonce, mac)).toBeUndefined()
  expect(new NativeChallengeInbox(undefined, () => now).takeNative(time, nonce, mac)).toBeUndefined()
})

it('caps pending challenges and requires one-use request ids', () => {
  const inbox = new NativeChallengeInbox(seed, () => now)
  for (let index = 0; index < 16; index += 1) {
    const entry = { ...challenge, requestId: `request-${String(index).padStart(8, '0')}` }
    expect(inbox.accept({ ...entry, mac: displayChallengeMac(seed, entry) })).toBe(true)
  }
  const next = { ...challenge, requestId: 'request-overflow' }
  expect(inbox.accept({ ...next, mac: displayChallengeMac(seed, next) })).toBe(false)
  const { time, nonce, mac } = proof()
  expect(inbox.takeNative(time, nonce, mac)?.requestId).toBe('request-00000000')
  expect(inbox.accept({ ...next, mac: displayChallengeMac(seed, next) })).toBe(true)
})
