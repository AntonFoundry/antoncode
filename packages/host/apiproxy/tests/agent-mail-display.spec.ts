import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { displayChallengeMac, NativeChallengeInbox } from '../../../../apps/anton-bridge/src/consent-challenges.ts'
import { deliverNativeChallenge, nativeDisplayMac } from '../src/agent-mail-display.ts'

const challenge = {
  requestId: 'test-request-111', binding: 'a'.repeat(64), expiresAt: 90_000,
  summary: 'Authorize local inbox for agent-1 in workspace-1',
}

describe('native display delivery', () => {
  it('matches bridge verifier and delivers only authenticated challenge fields', async () => {
    const key = randomBytes(32)
    expect(nativeDisplayMac(key, challenge)).toBe(displayChallengeMac(key, challenge))
    const inbox = new NativeChallengeInbox(key, () => 0)
    const transport = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(init?.method).toBe('POST')
      if (typeof init?.body !== 'string') throw new Error('challenge must use JSON text body')
      const body: unknown = JSON.parse(init.body)
      expect(JSON.stringify(body)).not.toContain(key.toString('base64'))
      return Response.json({ queued: true }, { status: inbox.accept(body) ? 200 : 403 })
    }
    expect(await deliverNativeChallenge(key, challenge, transport)).toBe(true)
    expect(await deliverNativeChallenge(key, challenge, transport)).toBe(false)
  })

  it('fails closed when native bridge is unavailable', async () => {
    const key = randomBytes(32)
    expect(await deliverNativeChallenge(key, challenge, async () => { throw new Error('offline') })).toBe(false)
  })
})
