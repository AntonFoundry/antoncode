import { describe, expect, it } from 'vitest'
import { agentDisplayName, agentNameTag } from '../src/client/agent-names.ts'
import { agentMentionToken, peersForChannel, resolveMentions } from '../src/client/mentions.ts'

describe('agent mentions', () => {
  const peer = (sessionId: string, workspaceId = 'w1') => ({ sessionId, workspaceId })

  it('keeps only peers reachable through the selected channel', () => {
    const peers = [peer('self'), peer('local'), peer('remote', 'w2')]
    expect(peersForChannel(peers, 'self', 'w1', 'local')).toEqual([peer('local')])
    expect(peersForChannel(peers, 'self', 'w1', 'direct')).toEqual([peer('remote', 'w2')])
    expect(peersForChannel(peers, 'self', undefined, 'direct')).toEqual([])
  })

  it('inserts a name and discriminator, never the session id', () => {
    const token = agentMentionToken('session-abc')
    expect(token).toBe(`${agentDisplayName('session-abc')}#${agentNameTag('session-abc')}`)
    expect(token).not.toContain('session-abc')
  })

  it('resolves tagged tokens and ignores unaddressed text', () => {
    const first = peer('session-one')
    const second = peer('session-two')
    const text = `hello @${agentMentionToken(first.sessionId)} and @${agentMentionToken(second.sessionId)}`
    expect(resolveMentions(text, [first, second])).toEqual([first.sessionId, second.sessionId])
    expect(resolveMentions('hello everyone', [first, second])).toEqual([])
  })

  it('keeps duplicate mentions unique and preserves first-mention order', () => {
    const first = peer('session-one')
    const second = peer('session-two')
    const text = `@${agentMentionToken(second.sessionId)} @${agentMentionToken(first.sessionId)} @${agentMentionToken(second.sessionId)}`
    expect(resolveMentions(text, [first, second])).toEqual([second.sessionId, first.sessionId])
  })
})
