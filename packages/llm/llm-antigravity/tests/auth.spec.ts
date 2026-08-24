// Unit tests for the Antigravity auth primitives: PKCE state roundtrip,
// token expiry math, and account-file serialization.

import { describe, expect, it } from 'vitest'
import {
  accessTokenExpired,
  calculateTokenExpiry,
  decodeState,
  generatePkce,
} from '../src/auth.ts'

describe('PKCE', () => {
  it('produces an S256 verifier/challenge pair', () => {
    const { challenge, verifier } = generatePkce()
    expect(verifier.length).toBeGreaterThan(40)
    expect(challenge.length).toBeGreaterThan(20)
    expect(challenge).not.toEqual(verifier)
  })
})

describe('OAuth state', () => {
  it('round-trips verifier and projectId through the state encoding', () => {
    const state = Buffer.from(JSON.stringify({ verifier: 'v'.repeat(64), projectId: 'proj-1' }), 'utf8').toString('base64url')
    const decoded = decodeState(state)
    expect(decoded.verifier).toBe('v'.repeat(64))
    expect(decoded.projectId).toBe('proj-1')
  })
  it('rejects state without a verifier', () => {
    const state = Buffer.from(JSON.stringify({ projectId: 'p' }), 'utf8').toString('base64url')
    expect(() => decodeState(state)).toThrow(/verifier/i)
  })
  it('tolerates a missing projectId', () => {
    const state = Buffer.from(JSON.stringify({ verifier: 'abc' }), 'utf8').toString('base64url')
    expect(decodeState(state).projectId).toBe('')
  })
})

describe('token expiry', () => {
  it('computes absolute expiry from a duration', () => {
    const now = Date.now()
    expect(calculateTokenExpiry(now, 3600)).toBe(now + 3_600_000)
  })
  it('treats non-positive durations as immediately expired', () => {
    const now = Date.now()
    expect(calculateTokenExpiry(now, 0)).toBe(now)
    expect(calculateTokenExpiry(now, 'x' as unknown as number)).toBe(now + 3_600_000)
  })
  it('flags missing or expired access tokens with the skew buffer', () => {
    expect(accessTokenExpired({})).toBe(true)
    expect(accessTokenExpired({ accessToken: 't', expires: Date.now() + 30_000 })).toBe(true)
    expect(accessTokenExpired({ accessToken: 't', expires: Date.now() + 120_000 })).toBe(false)
  })
})
