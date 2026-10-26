// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentMailConversationView, type AgentMailConversationViewProps } from '../src/client/AgentMailConversationView.tsx'
import type { AgentMailGateway } from '../src/client/gateway.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const t = (key: string): string => en[key as keyof typeof en] ?? key
const props = (gateway?: AgentMailGateway, sessionId = 'self'): AgentMailConversationViewProps =>
  ({ t, sessionId, gateway }) as AgentMailConversationViewProps

function fakeGateway() {
  let state: ReturnType<AgentMailGateway['authorization']> = { state: 'unpaired' }
  const authorizationListeners = new Set<() => void>()
  const inboxListeners = new Set<() => void>()
  const inbox: ReturnType<AgentMailGateway['inbox']> = {
    local: { cursor: 0, messages: [{ seq: 3, from: 'local', workspaceId: 'w1', body: 'Local mail', at: 0 }] },
    direct: { cursor: 0, messages: [{ seq: 8, from: 'remote', workspaceId: 'w2', body: 'Direct mail', at: 0 }] },
  }
  const refresh = vi.fn(async () => {})
  const read = vi.fn(() => inbox)
  const peers = vi.fn(() => [
    { sessionId: 'self', workspaceId: 'w1' },
    { sessionId: 'local', workspaceId: 'w1' },
    { sessionId: 'remote', workspaceId: 'w2' },
  ])
  const sendLocal = vi.fn(async () => {})
  const sendDirect = vi.fn(async () => {})
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
    gateway, inbox, read, peers, authorize, sendLocal, sendDirect, acknowledge,
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
    expect(fake.read).not.toHaveBeenCalled()
    await waitFor(() => { expect(fake.authorize).toHaveBeenCalledWith('self') })
    expect(screen.getByText('Local mail')).toBeTruthy()
  })

  it('stays read-only with the failure text when authorization fails', async () => {
    const fake = fakeGateway()
    fake.authorize.mockRejectedValueOnce(new Error('origin refused'))
    const view = render(<AgentMailConversationView {...props(fake.gateway)} />)
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('origin refused') })
    expect(view.container.querySelectorAll('[data-agent-mail] button,[data-agent-mail] input,[data-agent-mail] select,[data-agent-mail] textarea,[data-agent-mail] form')).toHaveLength(0)
    expect(fake.read).not.toHaveBeenCalled()
  })

  it('shows its address, distinct inboxes, and never acknowledges just by rendering', () => {
    const fake = fakeGateway()
    fake.authorize()
    render(<AgentMailConversationView {...props(fake.gateway)} />)
    expect(screen.getByText('Local mail')).toBeTruthy()
    expect(screen.getByText('Direct mail')).toBeTruthy()
    expect(screen.getByText('self')).toBeTruthy()
    expect(fake.acknowledge).not.toHaveBeenCalled()
  })

  it('routes same-workspace, cross-workspace and broadcast sends separately', async () => {
    const fake = fakeGateway()
    fake.authorize()
    render(<AgentMailConversationView {...props(fake.gateway)} />)
    const peer = screen.getByLabelText(en.peerLabel)
    const message = screen.getByLabelText(en.messageLabel) as HTMLTextAreaElement
    fireEvent.change(peer, { target: { value: 'local' } })
    fireEvent.change(message, { target: { value: 'one' } })
    fireEvent.click(screen.getByRole('button', { name: en.sendButton }))
    await waitFor(() => { expect(fake.sendLocal).toHaveBeenCalledWith({
      sessionId: 'self', workspaceId: 'w1', recipients: ['local'], body: 'one', workspaceWide: false,
    }) })
    await waitFor(() => { expect(message.value).toBe('') })
    fireEvent.change(peer, { target: { value: 'remote' } })
    fireEvent.change(message, { target: { value: 'two' } })
    fireEvent.click(screen.getByRole('button', { name: en.sendButton }))
    await waitFor(() => { expect(fake.sendDirect).toHaveBeenCalledWith({
      sessionId: 'self', workspaceId: 'w1', recipient: 'remote', body: 'two',
    }) })
    await waitFor(() => { expect(message.value).toBe('') })
    fireEvent.click(screen.getByLabelText(en.workspaceWide))
    fireEvent.change(message, { target: { value: 'all' } })
    fireEvent.click(screen.getByRole('button', { name: en.sendButton }))
    await waitFor(() => { expect(fake.sendLocal).toHaveBeenCalledWith({
      sessionId: 'self', workspaceId: 'w1', recipients: [], body: 'all', workspaceWide: true,
    }) })
  })

  it('acknowledges each ledger by its own sequence and subscription updates only', async () => {
    const fake = fakeGateway()
    fake.authorize()
    render(<AgentMailConversationView {...props(fake.gateway)} />)
    const local = screen.getByRole('region', { name: en.localInbox })
    const direct = screen.getByRole('region', { name: en.directInbox })
    const localButton = local.querySelector('button')
    const directButton = direct.querySelector('button')
    if (!localButton || !directButton) throw new Error('Missing inbox acknowledger')
    fireEvent.click(localButton)
    await waitFor(() => { expect(fake.acknowledge).toHaveBeenCalledWith({
      sessionId: 'self', workspaceId: 'w1', channel: 'local', throughSeq: 3,
    }) })
    fireEvent.click(directButton)
    await waitFor(() => { expect(fake.acknowledge).toHaveBeenCalledWith({
      sessionId: 'self', workspaceId: 'w1', channel: 'direct', throughSeq: 8,
    }) })
    fake.inbox.direct = { cursor: 8, messages: [] }
    fake.publish()
    expect(directButton.disabled).toBe(true)
  })
})
