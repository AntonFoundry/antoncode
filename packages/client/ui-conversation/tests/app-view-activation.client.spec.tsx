// @vitest-environment jsdom
// The app-plugin profile's load-bearing invariant (see
// .agents/notes/proposed/feature/2026-09-16-app-plugin-profile.md): the
// conversation.session.header registration shares the per-session chat store
// with its utilities occupants, so an app plugin's header toggle resolves the
// SAME store instance the view ring renders from — and activating its view id
// through that shared instance makes the app's conversation.view entry the
// active ring view. Registration parity: the chat entry rides the same handle.

import { describe, expect, it } from 'vitest'
import { SlotTestRuntime, usePinnedBrowserLanguages, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'

usePinnedBrowserLanguages('zh-CN')

const ROOT = 'root-1' as SessionId

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
  runtime.provide('remote', { $on: () => () => {} })
  runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const sessionFake = {
    open: () => Promise.resolve(),
  }
  await runtime.sessions.add({
    id: ROOT,
    summary: { title: 'R', displayTitle: 'R', cwd: '/proj' },
    session: sessionFake,
  })
  runtime.provide('layout', { openDetails: () => {}, closeDetails: () => {} })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)

  await runtime.root.declare({
    'conversation': { kind: 'single', scope: 'session-maybe' },
    'details': { kind: 'single', scope: 'session' },
  }, (_p: { renderSlot?: unknown }) => null)

  await runtime.mount({ inject: [...inject], apply })
  runtime.renderRoot()
  return runtime
}

describe('app-plugin view activation (header seat store share)', () => {
  it('shares the chat store with header utilities and activates a registered app view', async () => {
    const runtime = await bench()

    // The header registration declares the chat store (the load-bearing share).
    const headerEntry = runtime.slots.entries('conversation.session.header')[0]!
    expect(headerEntry.store).toBeDefined()

    // An app plugin registers its view and its header toggle through the same
    // slots service the convention prescribes.
    const appComponent = () => null
    runtime.slots.inject('conversation.view', () => runtime.slots.register({
      name: 'conversation.view', id: 'myapp', order: 30, label: () => 'MyApp',
    }, appComponent))
    runtime.slots.inject('conversation.session.header.utilities', () => runtime.slots.register({
      name: 'conversation.session.header.utilities', id: 'myapp-toggle', order: 90,
    }, appComponent))

    // The app plugin's header toggle consumes the activation channel the same
    // way a session-scope occupant does: through the provide info.
    const info = runtime.sessions.provideInfo(ROOT)!
    const viewActions = info.props['viewActions'] as { activate(viewId: string): void }
    expect(typeof viewActions.activate).toBe('function')

    // The app view registered alongside the shipped chat view.
    expect(runtime.slots.entries('conversation.view').length).toBe(2)

    // Before activation the ring selection is not the app view; one click
    // raises it through the channel (a plain chat-store write).
    const appViewInstance = runtime.storeOf('conversation.view', ROOT)
    expect(appViewInstance.getSnapshot().view).not.toBe('myapp')
    viewActions.activate('myapp')
    expect(appViewInstance.getSnapshot().view).toBe('myapp')
  })
})
