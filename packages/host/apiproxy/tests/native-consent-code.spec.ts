import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { nativeConsentCode, NativeConsentVerifier } from '../src/native-consent-code.ts'

const key = randomBytes(32)
const challenge = { requestId: 'request-a', binding: 'session-a/direct/recipient-a/body-a', expiresAt: 90_000 }

describe('native consent code', () => {
  it('derives a stable 40-bit display code without ambiguous concatenation', () => {
    const code = nativeConsentCode(key, challenge)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(nativeConsentCode(key, challenge)).toBe(code)
    expect(nativeConsentCode(key, { ...challenge, requestId: 'request-' })).not.toBe(
      nativeConsentCode(key, { ...challenge, binding: 'a' + challenge.binding }),
    )
    expect(nativeConsentCode(key, { ...challenge, binding: 'session-b/direct/recipient-a/body-a' })).not.toBe(code)
  })

  it('allows one successful redemption and rejects replay', () => {
    const verifier = new NativeConsentVerifier(key, () => 0)
    expect(verifier.issue(challenge)).toBe(true)
    expect(verifier.issue(challenge)).toBe(false)
    expect(verifier.verify(challenge.requestId, nativeConsentCode(key, challenge))).toBe(true)
    expect(verifier.verify(challenge.requestId, nativeConsentCode(key, challenge))).toBe(false)
  })

  it('rejects invalid codes and deletes after five guesses', () => {
    const verifier = new NativeConsentVerifier(key, () => 0)
    verifier.issue(challenge)
    for (let attempt = 0; attempt < 5; attempt += 1) expect(verifier.verify(challenge.requestId, 'AAAAAAAA')).toBe(false)
    expect(verifier.verify(challenge.requestId, nativeConsentCode(key, challenge))).toBe(false)
  })

  it('expires and revokes pending challenges', () => {
    let now = 0
    const verifier = new NativeConsentVerifier(key, () => now)
    expect(verifier.issue(challenge)).toBe(true)
    now = 90_000
    expect(verifier.verify(challenge.requestId, nativeConsentCode(key, challenge))).toBe(false)
    now = 0
    expect(verifier.issue(challenge)).toBe(true)
    verifier.revokeAll()
    expect(verifier.verify(challenge.requestId, nativeConsentCode(key, challenge))).toBe(false)
  })

  it('fails closed without a native key or with malformed boundaries', () => {
    expect(new NativeConsentVerifier(undefined, () => 0).issue(challenge)).toBe(false)
    expect(new NativeConsentVerifier(key, () => 0).issue({ ...challenge, expiresAt: 90_001 })).toBe(false)
    expect(() => nativeConsentCode(randomBytes(31), challenge)).toThrow()
  })
})
