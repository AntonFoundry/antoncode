import { describe, expect, it } from 'vitest'
import type { AgentMailComposerState } from '../src/client/composer-targets.ts'
import type { AgentMailPeer } from '../src/client/gateway.ts'
import { agentMentionToken } from '../src/client/mentions.ts'
import { resolveMailRecipients } from '../src/client/resolve-recipients.ts'

const peer = (sessionId: string, workspaceId: string, transport: AgentMailPeer['transport']): AgentMailPeer => ({
  sessionId: sessionId as AgentMailPeer['sessionId'], workspaceId: workspaceId as AgentMailPeer['workspaceId'], transport,
})
const local = peer('local', 'here', 'workspace-queue')
const remote = peer('remote', 'there', 'direct')
const farther = peer('farther', 'elsewhere', 'direct')
const sender = { sessionId: 'self', workspaceId: 'here' }
const selection = (channel: 'local' | 'direct', recipients: AgentMailPeer[] = []): AgentMailComposerState => ({
  channel, workspaceId: null, recipients,
})

describe('Mail submission recipient resolution', () => {
  it('keeps explicit direct recipients across workspaces in one transport', () => {
    expect(resolveMailRecipients(selection('direct', [remote, farther]), [local, remote, farther], sender, 'hello')).toEqual({
      ok: true, channel: 'direct', recipients: [remote, farther], workspaceWide: false,
    })
  })

  it('refuses stale, moved or changed-transport selections instead of broadcasting', () => {
    for (const peers of [[], [peer('local', 'moved', 'direct')], [peer('local', 'here', 'direct')]]) {
      expect(resolveMailRecipients(selection('local', [local]), peers, sender, 'hello')).toEqual({ ok: false, reason: 'staleRecipient' })
    }
  })

  it('refuses mixed transport selections even if interaction state was set directly', () => {
    expect(resolveMailRecipients(selection('direct', [remote, local]), [remote, local], sender, 'hello'))
      .toEqual({ ok: false, reason: 'wrongChannel' })
  })

  it('rejects generated mentions that no longer resolve, but permits ordinary @ prose', () => {
    expect(resolveMailRecipients(selection('local'), [], sender, `@${agentMentionToken('offline')} hello`))
      .toEqual({ ok: false, reason: 'staleRecipient' })
    expect(resolveMailRecipients(selection('local'), [], sender, 'Email help@example.com or @the-team'))
      .toEqual({ ok: true, channel: 'local', recipients: [], workspaceWide: true })
  })

  it('rejects conflicting mentions without silently adding or replacing picker recipients', () => {
    expect(resolveMailRecipients(selection('direct', [remote]), [remote, farther], sender, `@${agentMentionToken('farther')} hello`))
      .toEqual({ ok: false, reason: 'recipientConflict' })
    expect(resolveMailRecipients(selection('direct', [remote]), [remote], sender, `@${agentMentionToken('remote')} hello`))
      .toEqual({ ok: true, channel: 'direct', recipients: [remote], workspaceWide: false })
  })

  it('retains mention shortcuts, explicit local broadcast, and refusal of empty direct targets', () => {
    expect(resolveMailRecipients(selection('local'), [local], sender, `@${agentMentionToken('local')} hello`))
      .toEqual({ ok: true, channel: 'local', recipients: [local], workspaceWide: false })
    expect(resolveMailRecipients(selection('direct'), [remote], sender, 'hello')).toEqual({ ok: false, reason: 'mentionRequired' })
    expect(resolveMailRecipients(selection('local'), [remote], sender, `@${agentMentionToken('remote')} hello`))
      .toEqual({ ok: false, reason: 'wrongChannel' })
  })
})
