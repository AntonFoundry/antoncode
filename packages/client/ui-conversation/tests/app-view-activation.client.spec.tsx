// @vitest-environment jsdom
/** App Views activate through the Session source shared with the Conversation store. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createConversationStore } from '../src/client/stores.ts'
import type { ConversationViewActions } from '../src/client/contract/slots.ts'

const SID = 'app-view-session' as SessionId

describe('app View activation', () => {
  it('shares the header store and activates a registered View from the Session source', async () => {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    runtime.ctx.provide('uiWorkspace', {
      openWorkspace: vi.fn(async () => {}),
      openSession: vi.fn(),
    } as never)
    runtime.ctx.provide('configForms', {
      developerTools: { enabled: createSnapshotStore(true) },
      get: () => stubConfigForm().scope,
    } as never)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.root.declare({
      main: { kind: 'keyed', scope: 'root' },
      'settings.general.item': { kind: 'list', scope: 'root' },
    }, () => null)
    await runtime.mount({ inject: [...inject], apply })
    runtime.renderRoot()
    await runtime.sessions.add({ id: SID })
    using reference = runtime.sessions.retain(SID)
    await reference.ready

    const appComponent = () => null
    runtime.slots.register({ name: 'conversation.view', id: 'chat', label: 'Chat' }, appComponent)
    runtime.slots.register({ name: 'conversation.view', id: 'myapp', label: 'My app' }, appComponent)
    runtime.slots.register({ name: 'conversation.session.header.utilities', id: 'myapp-toggle' }, appComponent)

    const header = runtime.slots.entries('conversation.session.header')[0]!
    const session = runtime.slots.entries('conversation.session')[0]!
    expect(header.store).toBe(session.store)
    const store = runtime.storeOf('conversation.session', reference) as ReturnType<ReturnType<typeof createConversationStore>['create']>
    const injectSession = session.inject as (id: SessionId, actions: typeof store.actions) => object
    injectSession(SID, store.actions)
    expect(store.store.getSnapshot().view).not.toBe('myapp')

    const source = runtime.ctx.uiSession.adapter.bindingSource(reference).getSnapshot()
    const viewActions = source.props.viewActions as ConversationViewActions
    viewActions.activate('myapp')
    expect(store.store.getSnapshot().view).toBe('myapp')
    await runtime.flush()
  })
})
