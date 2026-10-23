import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signForwardedMailRequest } from '../../../../apps/anton-bridge/src/consent-forward.ts'
import { AgentMailForwardVerifier } from '../src/agent-mail-forward.ts'

const origin = 'http://antoncode.localhost:3742'
const path = '/api/agentMail.begin'
const original = () => new Request(`${origin}${path}`, { method: 'POST', headers: { origin } })
const target = () => new URL(`http://127.0.0.1:3080${path}`)
const received = (headers: Headers) => new Request(target(), { method: 'POST', headers })

describe('native bridge Agent Mail origin proof', () => {
  it('accepts one exact signed method, path and origin, rejects replay', () => {
    const key = randomBytes(32)
    const headers = new Headers(original().headers)
    expect(signForwardedMailRequest(original(), target(), headers, key, 3742, () => 10_000, () => 'a'.repeat(32))).toBe(true)
    const verifier = new AgentMailForwardVerifier(key, () => 10_000)
    expect(verifier.verify(received(headers))).toBe(origin)
    expect(verifier.verify(received(headers))).toBeUndefined()
  })

  it('fails closed on direct-host calls, spoofed headers, altered path, stale time and missing key', () => {
    const key = randomBytes(32)
    const headers = new Headers(original().headers)
    signForwardedMailRequest(original(), target(), headers, key, 3742, () => 10_000, () => 'b'.repeat(32))
    const verifier = new AgentMailForwardVerifier(key, () => 10_000)
    expect(verifier.verify(new Request(target(), { method: 'POST', headers: { origin: 'http://127.0.0.1:3080' } }))).toBeUndefined()
    expect(new AgentMailForwardVerifier(undefined, () => 10_000).verify(received(headers))).toBeUndefined()
    expect(new AgentMailForwardVerifier(key, () => 50_001).verify(received(headers))).toBeUndefined()
    headers.set('x-anton-mail-forward-origin', 'http://127.0.0.1:3080')
    expect(verifier.verify(received(headers))).toBeUndefined()
  })
})
