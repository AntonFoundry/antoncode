// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AgentMailConversationView, type AgentMailConversationViewProps } from '../src/client/AgentMailConversationView.tsx'
import { agentDisplayName } from '../src/client/agent-names.ts'
import { setAgentMailChannel } from '../src/client/composer-targets.ts'
import type { AgentMailGateway } from '../src/client/gateway.ts'
import { en } from '../src/client/locales.ts'
import type { AgentMailRelay } from '../src/client/relay-projection.ts'

afterEach(cleanup)
beforeEach(() => { setAgentMailChannel('self', 'local') })
const t = (key: string): string => en[key as keyof typeof en] ?? key
const conversation = { views: { get: () => [] } }
const useConversation = ((selector: (snapshot: unknown) => unknown) => selector(conversation)) as unknown as AgentMailConversationViewProps['useConversation']
const props = (gateway?: AgentMailGateway, sessionId = 'self'): AgentMailConversationViewProps =>
  ({ t, sessionId, gateway, useConversation }) as unknown as AgentMailConversationViewProps

function relayConversation(rows: readonly AgentMailRelay[]): AgentMailConversationViewProps['useConversation'] {
  return ((selector: (snapshot: unknown) => unknown) => selector({ views: { get: () => rows } })) as AgentMailConversationViewProps['useConversation']
}

function fakeGateway() {
  let state: ReturnType<AgentMailGateway['authorization']> = { state: 'unpaired' }
  const authorizationListeners = new Set<() => void>()
  const inboxListeners = new Set<() => void>()
  const inbox: ReturnType<AgentMailGateway['inbox']> = {
    local: { cursor: 0, messages: [{ seq: 3, from: 'local', workspaceId: 'w1', body: 'Local mail', at: 0 }] },
    direct: { cursor: 0, messages: [{ seq: 8, from: 'remote', workspaceId: 'w2', body: 'Direct mail', at: 0 }] },
    sent: [],
  }
  const refresh = vi.fn(async () => {})
  const read = vi.fn(() => inbox)
  const peers = vi.fn(() => [
    { sessionId: 'self', workspaceId: 'w1' },
    { sessionId: 'local', workspaceId: 'w1' },
    { sessionId: 'remote', workspaceId: 'w2' },
  ])
  const sendLocal = vi.fn(async () => ({ receipt: { seq: 10 } }))
  const sendDirect = vi.fn(async () => ({ receipt: { seq: 11 } }))
  const acknowledge = vi.fn(async () => {})
  const revoke = vi.fn(async () => {
    state = { state: 'revoked' }
    act(() => { for (const listener of authorizationListeners) listener() })
  })
  const authorize = vi.fn(async () => {
    state = { state: 'authorized', address: 'self', workspaceId: 'w1' }
    act(() => { for (const listener of authorizationListeners) listener() })
  })
  const gateway: AgentMailGateway = {
    authorization: () => state,
    subscribeAuthorization: (listener: () => void) => {
      authorizationListeners.add(listener)
      return () => { authorizationListeners.delete(listener) }
    },
    authorize,
    inbox: read,
    subscribeInbox: (listener: () => void) => {
      inboxListeners.add(listener)
      return () => { inboxListeners.delete(listener) }
    },
    peers, refresh, revoke,
    sendLocal, sendDirect, acknowledge,
  }
  return {
    gateway, inbox, read, peers, refresh, authorize, sendLocal, sendDirect, acknowledge,
    publish: () => { act(() => { for (const listener of inboxListeners) listener() }) },
  }
}

describe('authorized Agent Mail view', () => {
  it('mounts no operational controls when no gateway exists', () => {
    const view = render(<AgentMailConversationView {...props(undefined)} />)
    expect(view.container.querySelectorAll('[data-agent-mail] button,[data-agent-mail] input,[data-agent-mail] select,[data-agent-mail] textarea,[data-agent-mail] form')).toHaveLength(0)
  })

  it('authorizes the local session automatically, then reads the queue', async () => {
    const fake = fakeGateway()
    render(<AgentMailConversationView {...props(fake.gateway)} />)
    await waitFor(() => { expect(fake.authorize).toHaveBeenCalledWith('self') })
    expect(screen.getByText('Local mail')).toBeTruthy()
    expect(fake.read).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'general' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'direct' })).toBeTruthy()
  })

  it('stays read-only with the failure text when authorization fails', async () => {
    const fake = fakeGateway()
    fake.authorize.mockRejectedValueOnce(new Error('origin refused'))
    const view = render(<AgentMailConversationView {...props(fake.gateway)} />)
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('origin refused') })
    expect(view.container.querySelectorAll('[data-agent-mail] button,[data-agent-mail] input,[data-agent-mail] select,[data-agent-mail] textarea,[data-agent-mail] form')).toHaveLength(0)
    expect(fake.read).not.toHaveBeenCalled()
  })

  it('shows the human agent name, address, and distinct channel feeds', async () => {
    const fake = fakeGateway()
    render(<AgentMailConversationView {...props(fake.gateway)} />)
    await waitFor(() => { expect(fake.authorize).toHaveBeenCalled() })
    expect(screen.getByText(agentDisplayName('self'))).toBeTruthy()
    expect(screen.getByText(/self/)).toBeTruthy()
    expect(screen.getByText('Local mail')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'direct' }))
    expect(screen.getByText('Direct mail')).toBeTruthy()
    expect(screen.queryByText('Local mail')).toBeNull()
  })

  it('renders both directions from the Mail target without touching queue acknowledgements', async () => {
    const fake = fakeGateway()
    const rows: readonly AgentMailRelay[] = [
      { key: 'call:send', direction: 'outgoing', peer: 'child', body: 'Keep working', at: 1000 },
      { key: 'message:reply', direction: 'incoming', peer: 'child', body: 'Agent child sent a message: \nProgress report', at: 2000 },
    ]
    render(<AgentMailConversationView {...props(fake.gateway)} useConversation={relayConversation(rows)} />)
    await waitFor(() => { expect(screen.getByText('Keep working')).toBeTruthy() })
    expect(screen.getByText('Agent child sent a message: Progress report')).toBeTruthy()
    expect(fake.acknowledge).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'direct' }))
    expect(screen.queryByText('Keep working')).toBeNull()
    expect(screen.queryByText('Agent child sent a message: Progress report')).toBeNull()
  })

  it('places queue relays in their transport channel and uses their complete recipient list', async () => {
    const fake = fakeGateway()
    const rows: readonly AgentMailRelay[] = [
      { key: 'queue:local:w1:20', channel: 'local', direction: 'outgoing', peer: 'local', recipients: ['local', 'second'], workspaceId: 'w1', seq: 20, body: 'Local addressed queue mail', at: 1_000 },
      { key: 'queue:direct:w1:21', channel: 'direct', direction: 'outgoing', peer: 'remote', recipients: ['remote', 'other-remote'], workspaceId: 'w1', seq: 21, body: 'Direct queue mail', at: 2_000 },
      { key: 'call:adjacent', direction: 'outgoing', peer: 'child', body: 'Adjacent relay', at: 3_000 },
    ]
    render(<AgentMailConversationView {...props(fake.gateway)} useConversation={relayConversation(rows)} />)
    await waitFor(() => { expect(screen.getByText('Local addressed queue mail')).toBeTruthy() })
    const localRow = screen.getByText('Local addressed queue mail').closest('li')!
    expect(within(localRow).getByText(`@${agentDisplayName('second')}`, { exact: false })).toBeTruthy()
    expect(screen.getByText('Adjacent relay')).toBeTruthy()
    expect(screen.queryByText('Direct queue mail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'direct' }))
    expect(screen.getByText('Direct queue mail')).toBeTruthy()
    const directRow = screen.getByText('Direct queue mail').closest('li')!
    expect(within(directRow).getByText(`@${agentDisplayName('other-remote')}`, { exact: false })).toBeTruthy()
    expect(screen.queryByText('Adjacent relay')).toBeNull()
    expect(screen.queryByText('Local addressed queue mail')).toBeNull()
  })

  it('deduplicates queue inbox and relay identity without collapsing other workspaces', async () => {
    const fake = fakeGateway()
    fake.inbox.local.messages = [
      { seq: 20, from: 'self', workspaceId: 'w1', body: 'Self-addressed queue mail', at: 1_000 },
      { seq: 20, from: 'other', workspaceId: 'w2', body: 'Same sequence elsewhere', at: 2_000 },
    ]
    const rows: readonly AgentMailRelay[] = [{ key: 'queue:local:w1:20', channel: 'local', direction: 'outgoing', peer: 'self', recipients: ['self', 'second'], workspaceId: 'w1', seq: 20, body: 'Self-addressed queue mail', at: 1_000 }]
    render(<AgentMailConversationView {...props(fake.gateway)} useConversation={relayConversation(rows)} />)
    await waitFor(() => { expect(screen.getAllByText('Self-addressed queue mail')).toHaveLength(1) })
    expect(screen.getByText('Same sequence elsewhere')).toBeTruthy()
    expect(screen.getByText(`@${agentDisplayName('second')}`, { exact: false })).toBeTruthy()
  })

  it('renders the gateway outbox and deduplicates its self-addressed queue copies', async () => {
    const fake = fakeGateway()
    Object.assign(fake.inbox, { sent: [
      { key: 'sent:20', seq: 20, channel: 'local', from: 'self', to: ['self', 'second'], workspaceId: 'w1', body: 'Committed outbox mail', at: 1_000 },
      { key: 'sent:21', seq: 21, channel: 'direct', from: 'self', to: ['remote'], workspaceId: 'w1', body: 'Committed direct outbox', at: 2_000 },
    ] })
    fake.inbox.local.messages = [{ seq: 20, from: 'self', workspaceId: 'w1', body: 'Committed outbox mail', at: 1_000 }]
    const rows: readonly AgentMailRelay[] = [{ key: 'queue:local:w1:20', channel: 'local', direction: 'outgoing', peer: 'self', recipients: ['self', 'second'], workspaceId: 'w1', seq: 20, body: 'Committed outbox mail', at: 1_000 }]
    render(<AgentMailConversationView {...props(fake.gateway)} useConversation={relayConversation(rows)} />)
    await waitFor(() => { expect(screen.getAllByText('Committed outbox mail')).toHaveLength(1) })
    expect(screen.getByText(`@${agentDisplayName('second')}`, { exact: false })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'direct' }))
    expect(screen.getByText('Committed direct outbox')).toBeTruthy()
    expect(screen.queryByText('Committed outbox mail')).toBeNull()
  })

  it('refreshes explicitly without acknowledging, sending, or dropping retained mail on failure', async () => {
    const fake = fakeGateway()
    fake.refresh.mockRejectedValueOnce(new Error('queue query unavailable'))
    render(<AgentMailConversationView {...props(fake.gateway)} />)
    await waitFor(() => { expect(screen.getByText('Local mail')).toBeTruthy() })
    expect(fake.refresh).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('queue query unavailable') })
    expect(screen.getByText('Local mail')).toBeTruthy()
    expect(fake.acknowledge).not.toHaveBeenCalled()
    expect(fake.sendLocal).not.toHaveBeenCalled()
    expect(fake.sendDirect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => { expect(fake.refresh).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  })

  it('shows a localized committed-send refresh warning until the inbox snapshot clears it', async () => {
    const fake = fakeGateway()
    render(<AgentMailConversationView {...props(fake.gateway)} />)
    await waitFor(() => { expect(screen.getByText('Local mail')).toBeTruthy() })
    Object.assign(fake.inbox, { refreshError: 'private transport diagnostic' })
    fake.publish()
    expect(screen.getByRole('alert').textContent).toBe('Message sent, but the inbox could not refresh. Refresh to try again.')
    expect(screen.queryByText('private transport diagnostic')).toBeNull()
    expect(screen.getByText('Local mail')).toBeTruthy()
    Reflect.deleteProperty(fake.inbox, 'refreshError')
    fake.publish()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('uses the resident composer instead of an internal form', async () => {
    const fake = fakeGateway()
    const view = render(<AgentMailConversationView {...props(fake.gateway)} />)
    await waitFor(() => { expect(fake.authorize).toHaveBeenCalled() })
    expect(screen.queryByLabelText(en.peerLabel)).toBeNull()
    expect(screen.queryByLabelText(en.messageLabel)).toBeNull()
    expect(screen.queryByRole('button', { name: en.sendButton })).toBeNull()
    expect(screen.getByText(en.composerHint)).toBeTruthy()
    expect(view.container.querySelector('[data-conversation-composer-overlay]')).toBeTruthy()
  })

  it('acknowledges each channel by its own sequence', async () => {
    const fake = fakeGateway()
    render(<AgentMailConversationView {...props(fake.gateway)} />)
    await waitFor(() => { expect(fake.authorize).toHaveBeenCalled() })
    fireEvent.click(screen.getByRole('button', { name: en.markRead }))
    await waitFor(() => { expect(fake.acknowledge).toHaveBeenCalledWith({
      sessionId: 'self', workspaceId: 'w1', channel: 'local', throughSeq: 3,
    }) })
    fireEvent.click(screen.getByRole('button', { name: 'direct' }))
    fireEvent.click(screen.getByRole('button', { name: en.markRead }))
    await waitFor(() => { expect(fake.acknowledge).toHaveBeenCalledWith({
      sessionId: 'self', workspaceId: 'w1', channel: 'direct', throughSeq: 8,
    }) })
  })
})
