import { describe, expect, it } from 'vitest'
import { agentDisplayName, agentInitials } from '../src/client/agent-names.ts'

describe('agent display names', () => {
  it('derives a stable human name from a session id', () => {
    expect(agentDisplayName('session-9718a95c-16eb-4230-a703-348e657b997c'))
      .toBe(agentDisplayName('session-9718a95c-16eb-4230-a703-348e657b997c'))
    expect(agentDisplayName('session-9718a95c-16eb-4230-a703-348e657b997c')).toMatch(/^[A-Z][a-z]+ [A-Z][A-Za-zö]+$/)
  })

  it('gives different sessions different names', () => {
    const ids = ['session-a', 'session-b', 'session-c', 'session-d']
    expect(new Set(ids.map(agentDisplayName)).size).toBeGreaterThan(1)
  })

  it('derives the avatar mark from the generated name', () => {
    const id = 'session-9718a95c-16eb-4230-a703-348e657b997c'
    const [first, second] = agentDisplayName(id).split(' ')
    expect(agentInitials(id)).toBe(`${first?.charAt(0)}${second?.charAt(0)}`)
  })
})
