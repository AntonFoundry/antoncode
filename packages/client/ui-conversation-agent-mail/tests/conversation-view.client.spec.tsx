// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { AgentMailConversationView } from '../src/client/AgentMailConversationView.tsx'

const translations: Record<string, string> = {
  title: 'Agent Mail', readOnly: 'Read-only preview',
  unavailable: 'Inbox, send, and acknowledgement are unavailable until Host browser authorization exists.',
  addressLabel: 'Agent session address', noAddress: 'An address is an Agent session ID. This conversation view shows the current session ID only; it does not read or write the queue.',
  composeTitle: 'How to contact another session',
  composeHelp: 'Use agent_queue_send in the relevant Agent session after agent_queue_address. This does not send a message.',
  noEmail: 'Agent Mail is not Gmail or iCloud mail.',
}
describe('Agent Mail read-only conversation view', () => {
  it('registers only slots and locale, with no queue API dependency', async () => {
    expect(inject).toEqual(['slots', 'locale'])
    const ctx = new Context()
    await ctx.plugin(SlotRegistry, { packageName: '@deepseek-ai/dsh-client-ui-conversation' }).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const stopRoot = ctx.get('slots')!.register({
      name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = ctx.get('slots')!.entries('conversation.view')[0]!
    expect(entry.component).toBe(AgentMailConversationView)
    expect(entry.options.id).toBe('agent-mail')
    expect(resolveSlotLabel(entry.options.label)).toBe('Agent Mail')
    await ctx.fiber.dispose()
    stopRoot()
  })

  it('exposes a pure read-only view component and no messaging actions', () => {
    expect(AgentMailConversationView).toBeTypeOf('function')
    expect(translations.unavailable).toContain('unavailable until Host browser authorization')
    expect(translations.composeHelp).toContain('does not send a message')
    expect(translations.noEmail).toContain('not Gmail or iCloud')
    expect(translations.composeHelp).toContain('agent_queue_send')
    expect(Object.keys(translations)).not.toContain('sendButton')
    expect(Object.keys(translations)).not.toContain('acknowledgeButton')
  })

  it('describes session identifiers without inventing an address', () => {
    expect(translations.noAddress).toContain('current session ID only')
    expect(translations.noAddress).toContain('does not read or write the queue')
  })
})
