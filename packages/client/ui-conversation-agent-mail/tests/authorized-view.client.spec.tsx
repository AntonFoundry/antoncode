// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { AgentMailConversationView, type AgentMailConversationViewProps } from '../src/client/AgentMailConversationView.tsx'
import { agentDisplayName } from '../src/client/agent-names.ts'
import { createAgentMailComposerStore } from '../src/client/composer-targets.ts'
import type { AgentMailPeer, AgentMailSnapshot } from '../src/client/gateway.ts'
import { en } from '../src/client/locales.ts'
import type { AgentMailRelay } from '../src/client/relay-projection.ts'

afterEach(cleanup)
const t = (key: string): string => en[key as keyof typeof en] ?? key
const local = { sessionId: 'local', workspaceId: 'w1', transport: 'workspace-queue' } as AgentMailPeer
const remote = { sessionId: 'remote', workspaceId: 'w2', transport: 'direct' } as AgentMailPeer

function fixture(rows: readonly AgentMailRelay[] = []) {
  const store = createAgentMailComposerStore().create()
  let mail: AgentMailSnapshot = {
    authorization: { state: 'authorized', address: 'self', workspaceId: 'w1' }, peers: [local, remote],
    inbox: { local: { cursor: 0, messages: [{ seq: 3, from: 'local', workspaceId: 'w1', body: 'Local mail', at: 0 }] },
      direct: { cursor: 0, messages: [{ seq: 8, from: 'remote', workspaceId: 'w2', body: 'Direct mail', at: 0 }] }, sent: [] },
  }
  let resource: { status: 'live' | 'failed' | 'none'; value: AgentMailSnapshot | undefined; failure: undefined } = { status: 'live', value: mail, failure: undefined }
  const listeners = new Set<() => void>()
  const refresh = vi.fn(async () => {})
  const acknowledge = vi.fn(async (_channel: 'local' | 'direct', _seq: number) => {})
  const focus = vi.fn()
  const useResource = (() => useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => resource,
  )) as AgentMailConversationViewProps['useResource']
  const useStore: AgentMailConversationViewProps['useStore'] = selector => selector(useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot()))
  const props = {
    t, sessionId: 'self', useResource, useStore, actions: store.actions,
    useConversation: selector => selector({ views: { get: (() => rows) as never, grouped: () => undefined }, activeTargets: new Set(['agent-mail']) }),
    useSessions: (selector => selector({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' })),
    useWorkspaces: selector => selector({ items: [], worktrees: { byRepo: {}, prefs: {}, namesByWorkspaceId: {} },
      archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }),
    refreshMail: refresh, acknowledgeMail: acknowledge, focusComposer: focus,
  } as AgentMailConversationViewProps
  return { props, store, refresh, acknowledge, focus,
    update: (change: (value: AgentMailSnapshot) => AgentMailSnapshot, status: 'live' | 'failed' = 'live') => {
      mail = change(mail)
      resource = { status, value: mail, failure: undefined }
      act(() => { for (const listener of listeners) listener() })
    },
    unavailable: () => { resource = { status: 'none', value: undefined, failure: undefined }; act(() => { for (const listener of listeners) listener() }) },
  }
}

describe('authorized Agent Mail view', () => {
  it('keeps an unavailable mailbox inert without performing commands', () => {
    const fake = fixture()
    fake.unavailable()
    const view = render(<AgentMailConversationView {...fake.props} />)
    expect(view.container.querySelectorAll('button,input,select,textarea,form')).toHaveLength(0)
    expect(fake.refresh).not.toHaveBeenCalled()
  })

  it('shows distinct channels and acknowledges only the selected mailbox', async () => {
    const fake = fixture()
    render(<AgentMailConversationView {...fake.props} />)
    expect(screen.getByText('Local mail')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.markRead }))
    await waitFor(() => { expect(fake.acknowledge).toHaveBeenCalledWith('local', 3) })
    fireEvent.click(screen.getByRole('button', { name: 'direct' }))
    expect(screen.queryByText('Local mail')).toBeNull()
    expect(screen.getByText('Direct mail')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.markRead }))
    await waitFor(() => { expect(fake.acknowledge).toHaveBeenCalledWith('direct', 8) })
  })

  it('keeps adjacent relays local and routes queue relays with complete recipients', () => {
    const fake = fixture([
      { key: 'adjacent', direction: 'outgoing', peer: 'child', body: 'Adjacent relay', at: 1_000 },
      { key: 'queue', direction: 'outgoing', peer: 'remote', recipients: ['remote', 'other'], channel: 'direct', workspaceId: 'w1', seq: 20, body: 'Queue relay', at: 2_000 },
    ])
    render(<AgentMailConversationView {...fake.props} />)
    expect(screen.getByText('Adjacent relay')).toBeTruthy()
    expect(screen.queryByText('Queue relay')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'direct' }))
    expect(screen.queryByText('Adjacent relay')).toBeNull()
    const row = screen.getByText('Queue relay').closest('li')!
    expect(within(row).getByText(`@${agentDisplayName('other')}`, { exact: false })).toBeTruthy()
    expect(fake.acknowledge).not.toHaveBeenCalled()
  })

  it('deduplicates canonical queue identity across inbox, outbox and relays', () => {
    const fake = fixture([{ key: 'queue', direction: 'outgoing', peer: 'self', recipients: ['self', 'other'], channel: 'local', workspaceId: 'w1', seq: 20, body: 'One queue message', at: 1_000 }])
    fake.update(value => ({ ...value, inbox: { ...value.inbox,
      local: { cursor: 0, messages: [{ seq: 20, from: 'self', workspaceId: 'w1', body: 'One queue message', at: 1_000 }, { seq: 20, from: 'different', workspaceId: 'w2', body: 'Other workspace', at: 2_000 }] },
      sent: [{ key: 'sent', seq: 20, channel: 'local', from: 'self', to: ['self', 'other'], workspaceId: 'w1', body: 'One queue message', at: 1_000 }],
    } }))
    render(<AgentMailConversationView {...fake.props} />)
    expect(screen.getAllByText('One queue message')).toHaveLength(1)
    expect(screen.getByText('Other workspace')).toBeTruthy()
  })

  it('refreshes manually and preserves messages while displaying a retryable failure', async () => {
    const fake = fixture()
    fake.refresh.mockRejectedValueOnce(new Error('query unavailable'))
    render(<AgentMailConversationView {...fake.props} />)
    expect(fake.refresh).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('query unavailable') })
    expect(screen.getByText('Local mail')).toBeTruthy()
    expect(fake.acknowledge).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  })

  it('keeps the last feed visible when live updates fail and clears the warning on recovery', () => {
    const fake = fixture()
    render(<AgentMailConversationView {...fake.props} />)
    fake.update(value => value, 'failed')
    expect(screen.getByRole('alert').textContent).toBe(en.liveUpdatesFailed)
    expect(screen.getByText('Local mail')).toBeTruthy()
    fake.update(value => value)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('localizes committed-send refresh warnings without exposing transport diagnostics', () => {
    const fake = fixture()
    render(<AgentMailConversationView {...fake.props} />)
    fake.update(value => ({ ...value, inbox: { ...value.inbox, refreshError: 'private diagnostic' } }))
    expect(screen.getByRole('alert').textContent).toBe(en.sentButRefreshFailed)
    expect(screen.queryByText('private diagnostic')).toBeNull()
    fake.update(value => ({ ...value, inbox: { local: value.inbox.local, direct: value.inbox.direct, sent: value.inbox.sent } }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('replies to the exact sender workspace and session while preserving the resident draft', () => {
    const fake = fixture()
    render(<AgentMailConversationView {...fake.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'direct' }))
    fireEvent.click(screen.getByRole('button', { name: en.reply }))
    expect(fake.store.getSnapshot().recipients).toEqual([remote])
    expect(fake.store.getSnapshot().channel).toBe('direct')
    expect(fake.focus).toHaveBeenCalledOnce()
  })

  it('does not reply to a stale sender or a same-session address in another workspace', () => {
    const fake = fixture()
    fake.update(value => ({ ...value, peers: [{ ...remote, workspaceId: local.workspaceId }] }))
    render(<AgentMailConversationView {...fake.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'direct' }))
    expect(screen.getByRole('button', { name: en.reply }).hasAttribute('disabled')).toBe(true)
    expect(fake.focus).not.toHaveBeenCalled()
  })

  it('requires explicit clear-and-switch when another channel would discard recipients', () => {
    const fake = fixture()
    fake.store.actions.replaceRecipients([local])
    render(<AgentMailConversationView {...fake.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.clearAndSwitch }))
    expect(fake.store.getSnapshot().recipients).toEqual([])
    expect(fake.store.getSnapshot().channel).toBe('direct')
  })

  it('uses the resident composer without rendering a second message form', () => {
    const fake = fixture()
    render(<AgentMailConversationView {...fake.props} />)
    expect(screen.queryByRole('textbox', { name: en.messageLabel })).toBeNull()
    expect(screen.queryByRole('button', { name: en.sendButton })).toBeNull()
    expect(screen.getByText(en.composerHint)).toBeTruthy()
  })
})
