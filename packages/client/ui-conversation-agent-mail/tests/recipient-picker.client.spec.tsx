// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import { AgentMailRecipientPicker } from '../src/client/AgentMailRecipientPicker.tsx'
import type { AgentMailPeer } from '../src/client/gateway.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const local: AgentMailPeer = { sessionId: 'local-agent' as SessionId, workspaceId: 'here' as WorkspaceId, transport: 'workspace-queue' }
const remote: AgentMailPeer = { sessionId: 'remote-agent' as SessionId, workspaceId: 'there' as WorkspaceId, transport: 'direct' }
const other: AgentMailPeer = { sessionId: 'other-agent' as SessionId, workspaceId: 'elsewhere' as WorkspaceId, transport: 'direct' }
const t: React.ComponentProps<typeof AgentMailRecipientPicker>['t'] = key => key in en ? en[key as keyof typeof en] : key

function fixture(recipients: readonly AgentMailPeer[] = []) {
  return {
    t, channel: 'local' as const, workspaceId: 'there', recipients, peers: [local, remote, other],
    workspaces: [{ workspaceId: 'here', title: 'Current workspace' }, { workspaceId: 'there', title: 'Design workspace' }],
    titles: { 'remote-agent': 'Review the release' },
    onWorkspace: vi.fn(), onSelect: vi.fn(), onRemove: vi.fn(), onBroadcast: vi.fn(),
  }
}

describe('Agent Mail recipient picker', () => {
  it('offers only live workspaces and searches by their permitted title', () => {
    const props = fixture()
    render(<AgentMailRecipientPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.pickWorkspace }))
    fireEvent.change(screen.getByRole('searchbox', { name: en.searchWorkspaces }), { target: { value: 'Design' } })
    expect(screen.queryByRole('menuitem', { name: /Current workspace/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Design workspace/ }))
    expect(props.onWorkspace).toHaveBeenCalledWith('there')
  })

  it('shows session titles and exact addresses and selects only the browsed live workspace', () => {
    const props = fixture()
    render(<AgentMailRecipientPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.pickRecipient }))
    expect(screen.getByRole('menuitem', { name: /Review the release/ }).textContent).toContain('remote-a')
    expect(screen.queryByRole('menuitem', { name: /other-ag/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Review the release/ }))
    expect(props.onSelect).toHaveBeenCalledWith(remote, false)
  })

  it('requires an explicit replacement action for incompatible transport recipients', () => {
    const props = fixture([local])
    render(<AgentMailRecipientPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.pickRecipient }))
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(en.replaceRecipients) }))
    expect(props.onSelect).toHaveBeenCalledWith(remote, true)
  })

  it('permits multiple remote workspaces when the transport remains direct', () => {
    const props = fixture([other])
    render(<AgentMailRecipientPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.pickRecipient }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Review the release/ }))
    expect(props.onSelect).toHaveBeenCalledWith(remote, false)
  })

  it('closes menus with Escape and returns keyboard focus to the trigger', () => {
    const props = fixture()
    render(<AgentMailRecipientPicker {...props} />)
    const trigger = screen.getByRole('button', { name: en.pickWorkspace })
    trigger.focus()
    fireEvent.click(trigger)
    const search = screen.getByRole('searchbox', { name: en.searchWorkspaces })
    search.focus()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('does not offer peers removed from the latest live roster', () => {
    const props = fixture()
    const view = render(<AgentMailRecipientPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.pickRecipient }))
    view.rerender(<AgentMailRecipientPicker {...props} peers={[local]} />)
    expect(screen.queryByRole('menuitem', { name: /Review the release/ })).toBeNull()
    expect(screen.getByText(en.noLiveRecipients)).toBeTruthy()
  })
})
