// @vitest-environment jsdom
/** Agent Mail stays inert unless an optional Host-authorized gateway says otherwise. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as applyHost } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import {
  AgentMailConversationView, type AgentMailConversationViewProps,
} from '../src/client/AgentMailConversationView.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

/**
 * Every DOM shape through which a user could operate the queue: form
 * controls, submit targets, links, and anything keyboard- or
 * pointer-activatable. The read-only view must mount none of them.
 */
const OPERATIONAL = [
  'button', 'input', 'textarea', 'select', 'form', 'a[href]', 'label',
  '[role="button"]', '[role="textbox"]', '[role="combobox"]', '[role="listbox"]',
  '[role="menuitem"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  '[contenteditable]', '[tabindex]', '[onclick]',
].join(',')

/**
 * Locale lookup double: first dictionary owning the key wins, else the key
 * stays visible. Kept local so this read-only suite pulls in no slot-runtime
 * test harness it does not exercise.
 */
function makeTranslate(dict: Record<string, string>): (key: string) => string {
  return key => dict[key] ?? key
}

function props(
  dict: Record<string, string>,
  sessionId: string | undefined,
): AgentMailConversationViewProps {
  return { t: makeTranslate(dict), sessionId } as unknown as AgentMailConversationViewProps
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
    const entry = ctx.get('slots')!.entries('conversation.view')[0]
    expect(entry.component).toBe(AgentMailConversationView)
    expect(entry.options.id).toBe('agent-mail')
    expect(resolveSlotLabel(entry.options.label)).toBe('Agent Mail')
    // No provider exists in the unauthenticated composition.
    expect(entry.inject?.('session-1' as never)).toEqual({})
    await ctx.fiber.dispose()
    stopRoot()
  })

  it('contributes no Host behavior while no secure pairing issuer exists', () => {
    // The Host half is deliberately inert: there is no authorized browser
    // channel to serve, so it registers no service, route, or endpoint.
    applyHost()
    expect(applyHost).toHaveLength(0)
  })

  it('mounts zero operational controls over the unauthenticated API', () => {
    const view = render(<AgentMailConversationView {...props(en, 'session-1')} />)

    expect(view.container.querySelectorAll(OPERATIONAL)).toHaveLength(0)
    expect(view.container.textContent).toContain(en.readOnly)
    expect(view.container.textContent).toContain(en.unavailable)
  })

  it('shows the current session address without inventing one', () => {
    const view = render(<AgentMailConversationView {...props(en, 'session-7')} />)

    const address = view.container.querySelector('code')
    expect(address?.textContent).toBe('session-7')
    expect(view.container.textContent).not.toContain(en.noAddress)
  })

  it('explains the address instead of guessing when no session is bound', () => {
    const view = render(<AgentMailConversationView {...props(en, undefined)} />)

    expect(view.container.querySelector('code')).toBeNull()
    expect(view.container.textContent).toContain(en.noAddress)
    expect(view.container.querySelectorAll(OPERATIONAL)).toHaveLength(0)
  })

  it('keeps both locales in key parity and renders the Chinese dictionary', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())

    const view = render(<AgentMailConversationView {...props(zh, 'session-9')} />)

    expect(view.container.textContent).toContain(zh.readOnly)
    expect(view.container.querySelectorAll(OPERATIONAL)).toHaveLength(0)
  })

  it('directs messaging at the Agent tools and disclaims consumer mail', () => {
    expect(en.unavailable).toContain('local agent queue')
    expect(en.composeHelp).toContain('agent_queue_send')
    expect(en.composeHelp).toContain('does not send a message')
    expect(en.noAddress).toContain('does not read or write the queue')
    expect(en.noEmail).toContain('not Gmail or iCloud')
    expect(zh.noEmail).toContain('不是 Gmail 或 iCloud')
  })
})
