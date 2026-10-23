import { randomBytes } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { AgentMailConsent } from '../src/agent-mail-consent.ts'
import { nativeConsentCode } from '../src/native-consent-code.ts'

const agent = { id: 'agent-1' } as Agent
const revived = { id: 'agent-1' } as Agent
const scope = { agent, origin: 'http://127.0.0.1:3080', workspaceId: 'workspace-1', operations: ['local-read', 'direct-send'] as const }

describe('native Agent Mail grant lifecycle', () => {
  it('fails closed without private native seed and rejects unbounded scope', () => {
    expect(new AgentMailConsent(undefined, () => 0).begin(scope)).toBeUndefined()
    expect(new AgentMailConsent(randomBytes(32), () => 0).begin({ ...scope, operations: [] })).toBeUndefined()
  })

  it('binds redemption and operations to Agent object, origin and workspace', () => {
    const key = randomBytes(32)
    const consent = new AgentMailConsent(key, () => 0)
    const challenge = consent.begin(scope)!
    const code = nativeConsentCode(key, challenge)
    expect(consent.redeem(challenge.requestId, code, revived, scope.origin, scope.workspaceId)).toBeUndefined()
    expect(consent.redeem(challenge.requestId, code, agent, 'http://foreign', scope.workspaceId)).toBeUndefined()
    const grant = consent.redeem(challenge.requestId, code, agent, scope.origin, scope.workspaceId)!
    expect(grant).toEqual(expect.any(String))
    expect(consent.redeem(challenge.requestId, code, agent, scope.origin, scope.workspaceId)).toBeUndefined()
    expect(consent.allows(grant, agent, scope.origin, scope.workspaceId, 'local-read')).toBe(true)
    expect(consent.allows(grant, agent, scope.origin, scope.workspaceId, 'local-send')).toBe(false)
    expect(consent.allows(grant, revived, scope.origin, scope.workspaceId, 'direct-send')).toBe(false)
  })

  it('revokes on agent disposal and grant expiry', () => {
    let now = 0
    const key = randomBytes(32)
    const consent = new AgentMailConsent(key, () => now)
    const first = consent.begin(scope)!
    const token = consent.redeem(first.requestId, nativeConsentCode(key, first), agent, scope.origin, scope.workspaceId)!
    consent.revokeAgent(agent)
    expect(consent.allows(token, agent, scope.origin, scope.workspaceId, 'direct-send')).toBe(false)
    const second = consent.begin(scope)!
    const nextToken = consent.redeem(second.requestId, nativeConsentCode(key, second), agent, scope.origin, scope.workspaceId)!
    now = 30 * 60_000
    expect(consent.allows(nextToken, agent, scope.origin, scope.workspaceId, 'local-read')).toBe(false)
  })
})
