import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentMailMessage, AgentMailSentEntry, AgentMailSnapshot, AgentMailPeer } from './gateway.ts'
import { agentDisplayName, agentInitials, agentNameTag } from './agent-names.ts'
import type { createAgentMailComposerStore, AgentMailChannel } from './composer-targets.ts'
import { agentMailResourceAddress } from './mail-resource.ts'
import { AgentMailRecipientPicker } from './AgentMailRecipientPicker.tsx'
import { EMPTY_AGENT_MAIL_RELAYS, type AgentMailRelay } from './relay-projection.ts'
import styles from './AgentMailConversationView.module.css'

/** Mail commands injected by the registration that owns this Session. */
export interface AgentMailViewInjected {
  refreshMail: () => Promise<void>
  acknowledgeMail: (channel: AgentMailChannel, throughSeq: number) => Promise<void>
  focusComposer: () => void
}

export type AgentMailConversationViewProps = ConvViewProps & PropsLocale<'conversation.agentMail'>
  & PropsStore<ReturnType<typeof createAgentMailComposerStore>> & AgentMailViewInjected

/** One rendered feed row: queued mail or an outgoing `send_message` call. */
interface FeedEntry {
  readonly key: string
  readonly from: string
  readonly to?: readonly string[]
  readonly workspaceId: string
  readonly body: string
  readonly at: number
}

/** Merge queue copies by transport identity while retaining adjacent-Agent rows. */
function mailFeed({ channel, messages, sent, relays, sessionId }: {
  channel: AgentMailChannel
  messages: readonly AgentMailMessage[]
  sent: readonly AgentMailSentEntry[]
  relays: readonly AgentMailRelay[]
  sessionId: string
}): FeedEntry[] {
  const rows = new Map<string, FeedEntry>()
  const queueKey = (senderWorkspace: string, seq: number): string => JSON.stringify([channel, senderWorkspace, seq])
  for (const message of messages) {
    const key = queueKey(message.workspaceId, message.seq)
    rows.set(key, { key, from: message.from, workspaceId: message.workspaceId, body: message.body, at: message.at })
  }
  for (const entry of sent) {
    if (entry.channel !== channel) continue
    const key = queueKey(entry.workspaceId, entry.seq)
    rows.set(key, { key, from: entry.from, to: entry.to, workspaceId: entry.workspaceId, body: entry.body, at: entry.at })
  }
  for (const relay of relays) {
    if ((relay.channel ?? 'local') !== channel) continue
    const key = relay.channel !== undefined && relay.workspaceId !== undefined && relay.seq !== undefined
      ? queueKey(relay.workspaceId, relay.seq) : relay.key
    rows.set(key, {
      key, from: relay.direction === 'incoming' ? relay.peer : sessionId,
      to: relay.recipients ?? [relay.direction === 'incoming' ? sessionId : relay.peer],
      workspaceId: relay.workspaceId ?? '', body: relay.body, at: relay.at,
    })
  }
  return [...rows.values()].sort((left, right) => left.at - right.at)
}

/** The absent, connecting, and unauthorized states deliberately use the original inert DOM. */
function ReadOnlyMail({ t, sessionId, statusText }: AgentMailConversationViewProps & {
  statusText: string
}): React.JSX.Element {
  return (
    <section aria-labelledby="agent-mail-title" data-agent-mail="">
      <header>
        <h2 id="agent-mail-title">{t('title')}</h2>
        <span>{t('readOnly')}</span>
      </header>
      <p role="status">{statusText}</p>
      <section aria-labelledby="agent-mail-address-title">
        <h3 id="agent-mail-address-title">{t('addressLabel')}</h3>
        {sessionId ? <code>{sessionId}</code> : <p>{t('noAddress')}</p>}
      </section>
      <section aria-labelledby="agent-mail-compose-title">
        <h3 id="agent-mail-compose-title">{t('composeTitle')}</h3>
        <p>{t('composeHelp')}</p>
      </section>
      <p>{t('noEmail')}</p>
    </section>
  )
}

/** Resource ownership authorizes and follows mail; this component only presents its snapshot. */
export function AgentMailConversationView(props: AgentMailConversationViewProps): React.JSX.Element {
  const resource = props.useResource<'agentmail'>(agentMailResourceAddress(props.sessionId))
  const snapshot = resource.value
  if (snapshot?.authorization.state !== 'authorized' || snapshot.authorization.workspaceId === undefined) {
    return <ReadOnlyMail {...props} statusText={props.t(resource.status === 'loading' ? 'connecting' : 'unavailable')} />
  }
  return <AuthorizedMail {...props} mail={snapshot} workspaceId={snapshot.authorization.workspaceId}
    liveFailed={resource.status === 'failed'} />
}

/** Short display id for an agent session (`9718a95c`). */
function shortId(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8)
}

/** Deterministic avatar hue per agent id, so an agent keeps its color. */
function avatarHue(id: string): number {
  let hue = 0
  for (const character of id) hue = (hue * 31 + (character.codePointAt(0) ?? 0)) % 360
  return hue
}

function AgentAvatar({ id, small }: { id: string; small?: boolean }): React.JSX.Element {
  return (
    <span
      className={small === true ? styles.avatarSmall : styles.avatar}
      style={{ background: `hsl(${avatarHue(id)} 42% 40%)` } satisfies CSSProperties}
      aria-hidden="true"
    >
      {agentInitials(id)}
    </span>
  )
}

function clockText(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function AuthorizedMail({ sessionId, workspaceId, mail, liveFailed, t, useConversation, useSessions, useWorkspaces,
  useStore, actions, refreshMail, acknowledgeMail, focusComposer }: AgentMailConversationViewProps & {
    mail: AgentMailSnapshot
    workspaceId: string
    liveFailed: boolean
  }): React.JSX.Element {
  const selection = useStore(value => value)
  const { channel, recipients } = selection
  const inbox = mail.inbox
  const peers = mail.peers.filter(peer => peer.sessionId !== sessionId)
  const workspaces = useWorkspaces(value => value.items)
  const titles = useSessions(value => Object.fromEntries(value.ids.flatMap((id) => {
    const title = value.byId[id]?.title
    return title === undefined ? [] : [[id, title]]
  })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const relays = useConversation(snapshot => snapshot.views.get('agent-mail')) ?? EMPTY_AGENT_MAIL_RELAYS

  const page = inbox[channel]
  const messages = page.messages
  const feed = useMemo(() => mailFeed({ channel, messages, sent: inbox.sent, relays, sessionId }),
    [channel, inbox.sent, messages, relays, sessionId])

  const perform = async (operation: () => Promise<void>, success: string): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await operation()
      setStatus(success)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('failed'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const acknowledge = (): void => {
    const throughSeq = messages.reduce((highest, message) => Math.max(highest, message.seq), page.cursor)
    void perform(() => acknowledgeMail(channel, throughSeq), t('acknowledged'))
  }

  const switchChannel = (next: AgentMailChannel): void => {
    actions.setChannel(next)
    setError('')
    setStatus('')
  }

  return (
    <div className={styles.shell} data-agent-mail="authorized" data-conversation-composer-overlay="">
      <aside className={styles.sidebar} aria-label={t('title')}>
        <div className={styles.brand}><span className={styles.brandMark}>✦</span>{t('title')}</div>
        <nav className={styles.channels} aria-label={t('channelsLabel')}>
          {(['local', 'direct'] as const).map(candidate => (
            <button
              key={candidate}
              type="button"
              className={channel === candidate ? styles.channelActive : styles.channel}
              aria-current={channel === candidate ? 'page' : undefined}
              aria-label={t(candidate !== channel && recipients.length > 0 ? 'clearAndSwitch' : candidate === 'local' ? 'channelGeneral' : 'channelDirect')}
              onClick={() => { switchChannel(candidate) }}
            >
              <span className={styles.hash}>#</span>
              <span className={styles.channelName}>{t(candidate === 'local' ? 'channelGeneral' : 'channelDirect')}
                {candidate !== channel && recipients.length > 0 && <span className={styles.channelWarning}>{t('clearAndSwitch')}</span>}
              </span>
              {inbox[candidate].messages.length > 0 && <span className={styles.badge}>{inbox[candidate].messages.length}</span>}
            </button>
          ))}
        </nav>
        <div className={styles.me}>
          <AgentAvatar id={sessionId} small />
          <div className={styles.meText}>
            <strong title={sessionId}>{agentDisplayName(sessionId)}<span className={styles.tag}>#{agentNameTag(sessionId)}</span></strong>
            <span>{shortId(sessionId)} · {t('you')} · {workspaceId}</span>
          </div>
        </div>
      </aside>
      <section className={styles.main}>
        <header className={styles.header}>
          <div className={styles.headerTitle}>
            <span className={styles.hash}>#</span>{t(channel === 'local' ? 'channelGeneral' : 'channelDirect')}
            <span className={styles.headerHelp}>{t(channel === 'local' ? 'channelGeneralHelp' : 'channelDirectHelp')}</span>
          </div>
          <div className={styles.headerActions}>
            <button type="button" className={styles.readButton} disabled={busy}
              onClick={() => { void perform(refreshMail, '') }}>{t('refresh')}</button>
            <button type="button" className={styles.readButton} disabled={busy || messages.length === 0}
              onClick={acknowledge}>{t('markRead')}</button>
          </div>
        </header>
        <AgentMailRecipientPicker channel={channel} workspaceId={selection.workspaceId ?? workspaceId}
          recipients={recipients} peers={peers} workspaces={workspaces} titles={titles} t={t}
          onWorkspace={actions.setWorkspace} onRemove={actions.removeRecipient} onBroadcast={actions.clearRecipients}
          onSelect={(peer, replace) => {
            actions.replaceRecipients(replace ? [peer] : [...recipients.filter(value => value.sessionId !== peer.sessionId), peer])
          }} />
        <p className={styles.composerHint}>{t('composerHint')}</p>
        {(error || inbox.refreshError !== undefined || liveFailed) && (
          <p className={styles.error} role="alert">{error || t(inbox.refreshError !== undefined ? 'sentButRefreshFailed' : 'liveUpdatesFailed')}</p>
        )}
        <ol className={styles.feed} aria-label={t(channel === 'local' ? 'localInbox' : 'directInbox')}>
          {feed.length === 0 && <li className={styles.empty}>{t('emptyChannel')}</li>}
          {feed.map((message, index) => {
            const previous = feed[index - 1]
            const grouped = previous !== undefined && previous.from === message.from
              && previous.to?.join('\0') === message.to?.join('\0')
              && message.at - previous.at < 5 * 60_000
            return (
              <li key={message.key} className={grouped ? styles.grouped : styles.message}>
                {grouped ? <span className={styles.avatarSpacer} /> : <AgentAvatar id={message.from} />}
                <div className={styles.messageBody}>
                  {!grouped && (
                    <div className={styles.messageHead}>
                      <strong className={styles.author} title={message.from}>
                        {agentDisplayName(message.from)}
                        <span className={styles.tag}>#{agentNameTag(message.from)}</span>
                      </strong>
                      {message.to !== undefined && message.to.length > 0 && (
                        <span className={styles.recipient}>
                          {message.to.map(recipient => (
                            <span key={recipient}>
                              @{agentDisplayName(recipient)}<span className={styles.tag}>#{agentNameTag(recipient)}</span>
                              {' '}
                            </span>
                          ))}
                        </span>
                      )}
                      <time className={styles.time} dateTime={new Date(message.at).toISOString()}>{clockText(message.at)}</time>
                      {message.workspaceId !== '' && <span className={styles.workspace}>{message.workspaceId}</span>}
                    </div>
                  )}
                  <p className={styles.text}>{message.body}</p>
                  {message.from !== sessionId && <ReplyAction message={message} peers={peers} channel={channel} t={t}
                    onReply={(peer) => { actions.replaceRecipients([peer]); focusComposer() }} />}
                </div>
              </li>
            )
          })}
        </ol>
        {status && <p className={styles.status} role="status">{status}</p>}
      </section>
    </div>
  )
}

/** A reply selects the exact currently-live sender address without replacing draft text. */
function ReplyAction({ message, peers, channel, onReply, t }: {
  message: FeedEntry
  peers: readonly AgentMailPeer[]
  channel: AgentMailChannel
  onReply: (peer: AgentMailPeer) => void
} & PropsLocale<'conversation.agentMail'>): React.JSX.Element {
  const peer = peers.find(value => value.sessionId === message.from && value.workspaceId === message.workspaceId
    && value.transport === (channel === 'direct' ? 'direct' : 'workspace-queue'))
  return <button type="button" className={styles.readButton} disabled={peer === undefined}
    title={peer === undefined ? t('replyUnavailable') : undefined}
    onClick={() => { if (peer !== undefined) onReply(peer) }}>{t('reply')}</button>
}
