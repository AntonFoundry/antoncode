import { describe, expect, it } from 'vitest'
import { mailConsentBinding, type MailConsentAction } from '../src/native-consent-binding.ts'

const action: MailConsentAction = {
  sessionId: 'session-a', generation: 'generation-1', origin: 'http://antoncode.localhost:3742',
  workspaceId: 'workspace-a', operation: 'direct-send', recipients: ['session-z', 'session-b'],
  body: 'Hello',
}

describe('Agent Mail action consent binding', () => {
  it('is deterministic and order-independent only for a recipient set', () => {
    expect(mailConsentBinding(action)).toMatch(/^[0-9a-f]{64}$/)
    expect(mailConsentBinding({ ...action, recipients: ['session-b', 'session-z'] })).toBe(mailConsentBinding(action))
  })

  it.each([
    { generation: 'generation-2' },
    { sessionId: 'session-b' },
    { origin: 'http://127.0.0.1:3080' },
    { workspaceId: 'workspace-b' },
    { operation: 'local-send' as const },
    { recipients: ['session-z'] },
    { body: 'Hello!' },
    { throughSeq: 1 },
  ])('changes if any live identity or action fact changes', (difference) => {
    expect(mailConsentBinding({ ...action, ...difference })).not.toBe(mailConsentBinding(action))
  })

  it('does not concatenate ambiguous variable-length fields', () => {
    expect(mailConsentBinding({ ...action, sessionId: 'a', generation: 'bc' })).not.toBe(
      mailConsentBinding({ ...action, sessionId: 'ab', generation: 'c' }),
    )
  })
})
