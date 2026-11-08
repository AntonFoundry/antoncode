import { useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentMailPeer } from './gateway.ts'
import { agentDisplayName } from './agent-names.ts'
import type { AgentMailChannel } from './composer-targets.ts'
import styles from './AgentMailConversationView.module.css'

interface RecipientPickerProps extends PropsLocale<'conversation.agentMail'> {
  channel: AgentMailChannel
  workspaceId: string | null
  recipients: readonly AgentMailPeer[]
  peers: readonly AgentMailPeer[]
  workspaces: readonly { workspaceId: string; title: string }[]
  titles: Readonly<Record<string, string>>
  onWorkspace: (workspaceId: string) => void
  onSelect: (peer: AgentMailPeer, replace: boolean) => void
  onRemove: (sessionId: string) => void
  onBroadcast: () => void
}

/** Search permitted live addresses without changing the draft or committing mail. */
export function AgentMailRecipientPicker({
  channel, workspaceId, recipients, peers, workspaces, titles, onWorkspace, onSelect, onRemove, onBroadcast, t,
}: RecipientPickerProps): React.JSX.Element {
  const [open, setOpen] = useState<'workspace' | 'recipient' | null>(null)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const workspaceIds = [...new Set(peers.map(peer => peer.workspaceId))]
  const titleOf = (id: string): string => workspaces.find(workspace => workspace.workspaceId === id)?.title || id
  const workspaceRows = workspaceIds.filter(id => `${titleOf(id)} ${id}`.toLocaleLowerCase().includes(needle))
  const candidates = peers.filter(peer => peer.workspaceId === workspaceId
    && `${titles[peer.sessionId] ?? ''} ${agentDisplayName(peer.sessionId)} ${peer.sessionId}`.toLocaleLowerCase().includes(needle))
  const toggle = (menu: 'workspace' | 'recipient'): void => {
    setQuery('')
    setOpen(value => value === menu ? null : menu)
  }
  return (
    <div className={styles.recipientPicker}>
      <div className={styles.pickerActions}>
        <Menu open={open === 'workspace'} portal
          anchor={<button type="button" className={styles.readButton} aria-label={t('pickWorkspace')}
            onClick={() => { toggle('workspace') }}>{workspaceId === null ? t('pickWorkspace') : titleOf(workspaceId)}</button>}
          header={<input type="search" className={styles.pickerSearch} aria-label={t('searchWorkspaces')}
            value={query} onChange={(event) => { setQuery(event.target.value) }} />}
          items={workspaceRows.map(id => ({ id, label: titleOf(id) }))}
          onSelect={(id) => { onWorkspace(id); setOpen(null) }} onClose={() => { setOpen(null) }} />
        <Menu open={open === 'recipient'} portal
          anchor={<button type="button" className={styles.readButton} aria-label={t('pickRecipient')} disabled={workspaceId === null}
            onClick={() => { toggle('recipient') }}>{t('pickRecipient')}</button>}
          header={<input type="search" className={styles.pickerSearch} aria-label={t('searchRecipients')}
            value={query} onChange={(event) => { setQuery(event.target.value) }} />}
          items={candidates.map((peer) => {
            const replace = recipients.some(selected => selected.transport !== peer.transport)
            return { id: peer.sessionId, label: <span className={styles.pickerPeer}>
              {titles[peer.sessionId] && <span>{titles[peer.sessionId]}</span>}
              <span>{agentDisplayName(peer.sessionId)} · {peer.sessionId.replace(/^session-/, '').slice(0, 8)}</span>
              <span>{t(peer.transport === 'direct' ? 'transportDirect' : 'transportLocal')}</span>
              {replace && <span>{t('replaceRecipients')}</span>}
            </span> }
          })}
          onSelect={(id) => {
            const peer = candidates.find(candidate => candidate.sessionId === id)
            if (peer === undefined) return
            onSelect(peer, recipients.some(selected => selected.transport !== peer.transport))
            setOpen(null)
          }} onClose={() => { setOpen(null) }}>
          {candidates.length === 0 && <p className={styles.pickerEmpty}>{t('noLiveRecipients')}</p>}
        </Menu>
        {channel === 'local' && <button type="button" className={styles.readButton} onClick={onBroadcast}>{t('channelEveryone')}</button>}
      </div>
      <div className={styles.selectedRecipients}>
        {recipients.length === 0 && <span>{t(channel === 'local' ? 'broadcastSelected' : 'recipientRequired')}</span>}
        {recipients.map(peer => <button type="button" className={styles.readButton} key={peer.sessionId}
          aria-label={`${t('removeRecipient')} ${agentDisplayName(peer.sessionId)}`} onClick={() => { onRemove(peer.sessionId) }}>
          {agentDisplayName(peer.sessionId)} · {peer.sessionId.replace(/^session-/, '').slice(0, 8)} ×
        </button>)}
      </div>
    </div>
  )
}
