import { describe, expect, it } from 'vitest'
import { createAgentMailComposerStore } from '../src/client/composer-targets.ts'
import type { AgentMailPeer } from '../src/client/gateway.ts'

const peer = (sessionId: string, workspaceId: string, transport: AgentMailPeer['transport']): AgentMailPeer => ({
  sessionId: sessionId as AgentMailPeer['sessionId'],
  workspaceId: workspaceId as AgentMailPeer['workspaceId'],
  transport,
})

describe('Agent Mail composer choices', () => {
  it('keeps Session instances and plugin handles independent', () => {
    const handle = createAgentMailComposerStore()
    const first = handle.create('first')
    const second = handle.create('second')
    first.actions.replaceRecipients([peer('remote', 'other', 'direct')])
    expect(first.getSnapshot().channel).toBe('direct')
    expect(second.getSnapshot()).toEqual({ channel: 'local', workspaceId: null, recipients: [] })
    expect(createAgentMailComposerStore().create('first').getSnapshot().recipients).toEqual([])
  })

  it('browses another workspace without changing addressed recipients', () => {
    const instance = createAgentMailComposerStore().create()
    const recipient = peer('remote', 'other', 'direct')
    instance.actions.replaceRecipients([recipient])
    instance.actions.setWorkspace('third')
    expect(instance.getSnapshot()).toEqual({ channel: 'direct', workspaceId: 'third', recipients: [recipient] })
  })

  it('replaces reply recipients and explicitly clears them on channel changes', () => {
    const instance = createAgentMailComposerStore().create()
    instance.actions.replaceRecipients([peer('remote', 'other', 'direct')])
    instance.actions.replaceRecipients([peer('local', 'here', 'workspace-queue')])
    expect(instance.getSnapshot().channel).toBe('local')
    expect(instance.getSnapshot().recipients.map(recipient => recipient.sessionId)).toEqual(['local'])
    instance.actions.setChannel('direct')
    expect(instance.getSnapshot()).toEqual({ channel: 'direct', workspaceId: null, recipients: [] })
  })

  it('removes or clears recipients without silently switching transport', () => {
    const instance = createAgentMailComposerStore().create()
    instance.actions.replaceRecipients([peer('one', 'other', 'direct'), peer('two', 'third', 'direct')])
    instance.actions.removeRecipient('one')
    expect(instance.getSnapshot().recipients.map(recipient => recipient.sessionId)).toEqual(['two'])
    instance.actions.clearRecipients()
    expect(instance.getSnapshot()).toEqual({ channel: 'direct', workspaceId: 'other', recipients: [] })
  })
})
