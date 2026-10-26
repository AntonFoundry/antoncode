import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentMailGateway } from './gateway.ts'
import { agentDisplayName, agentInitials, agentNameTag } from './agent-names.ts'
import styles from './AgentMailConversationView.module.css'

export type AgentMailConversationViewProps = ConvViewProps & PropsLocale<'conversation.agentMail'> & {
  gateway?: AgentMailGateway
}

type Authorization = ReturnType<AgentMailGateway['authorization']>
type Inbox = ReturnType<AgentMailGateway['inbox']>

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

/** No queue reader, peer discovery or mutator is called until the Host grants this session. */
export function AgentMailConversationView(props: AgentMailConversationViewProps): React.JSX.Element {
  const { gateway, sessionId, t } = props
  const [authorization, setAuthorization] = useState<{
    gateway: AgentMailGateway
    sessionId: string
    value: Authorization
  } | undefined>(() => gateway && sessionId
    ? { gateway, sessionId, value: gateway.authorization(sessionId) } : undefined)
  const [connectError, setConnectError] = useState<string>()
  useEffect(() => {
    if (!gateway || !sessionId) {
      setAuthorization(undefined)
      return
    }
    const refresh = (): void => { setAuthorization({ gateway, sessionId, value: gateway.authorization(sessionId) }) }
    const unsubscribe = gateway.subscribeAuthorization(refresh)
    refresh() // close the race between initial snapshot and listener registration
    return unsubscribe
  }, [gateway, sessionId])
  // The local harness UI authorizes itself: the Host mints the grant from the
  // bridge-proven loopback origin, so there is no code or confirmation step.
  useEffect(() => {
    if (!gateway || !sessionId) return
    if (gateway.authorization(sessionId).state === 'authorized') return
    let cancelled = false
    setConnectError(undefined)
    void gateway.authorize(sessionId).catch((cause: unknown) => {
      if (!cancelled) setConnectError(cause instanceof Error ? cause.message : t('failed'))
    })
    return () => { cancelled = true }
  }, [gateway, sessionId, t])
  if (!gateway || !sessionId || authorization?.gateway !== gateway || authorization.sessionId !== sessionId
    || authorization.value.state !== 'authorized' || !authorization.value.workspaceId
    || gateway.authorization(sessionId).state !== 'authorized') {
    return <ReadOnlyMail {...props} statusText={!gateway || !sessionId
      ? t('unavailable') : connectError ?? t('connecting')} />
  }
  return <AuthorizedMail {...props} gateway={gateway} workspaceId={authorization.value.workspaceId} />
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

function AuthorizedMail({ gateway, sessionId, workspaceId, t }: AgentMailConversationViewProps & {
  gateway: AgentMailGateway
  sessionId: NonNullable<AgentMailConversationViewProps['sessionId']>
  workspaceId: string
}): React.JSX.Element {
  const [channel, setChannel] = useState<'local' | 'direct'>('local')
  const [inbox, setInbox] = useState<Inbox>(() => gateway.inbox(sessionId))
  const [peer, setPeer] = useState('')
  const [body, setBody] = useState('')
  const [workspaceWide, setWorkspaceWide] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  useEffect(() => {
    const refresh = (): void => { setInbox({ ...gateway.inbox(sessionId) }) }
    const unsubscribe = gateway.subscribeInbox(refresh)
    refresh() // close the subscription race; never acknowledge merely by displaying
    return unsubscribe
  }, [gateway, sessionId])

  const page = inbox[channel]
  const messages = page.messages
  const peers = gateway.peers(sessionId).filter(candidate => candidate.sessionId !== sessionId)
  const activePeers = peers.filter(candidate => (candidate.workspaceId === workspaceId) === (channel === 'local'))
  const target = activePeers.find(candidate => candidate.sessionId === peer)
  const ready = (): boolean => gateway.authorization(sessionId).state === 'authorized'
    && gateway.authorization(sessionId).workspaceId === workspaceId

  const perform = async (operation: () => Promise<void>, success: string): Promise<boolean> => {
    if (!ready() || busy) return false
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await operation()
      if (ready()) {
        setInbox({ ...gateway.inbox(sessionId) })
        setStatus(success)
      }
      return true
    } catch (cause) {
      if (ready()) setError(cause instanceof Error ? cause.message : t('failed'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const text = body.trim()
    if (!text) return
    const operation = (): Promise<void> => {
      if (channel === 'direct') {
        return target === undefined ? Promise.resolve() : gateway.sendDirect({
          sessionId, workspaceId, recipient: target.sessionId, body: text,
        })
      }
      if (workspaceWide) return gateway.sendLocal({ sessionId, workspaceId, recipients: [], body: text, workspaceWide: true })
      return target === undefined ? Promise.resolve() : gateway.sendLocal({
        sessionId, workspaceId, recipients: [target.sessionId], body: text, workspaceWide: false,
      })
    }
    void perform(operation, t('sent')).then((sent) => {
      if (sent && ready()) setBody('')
    })
  }

  const acknowledge = (): void => {
    const throughSeq = messages.reduce((highest, message) => Math.max(highest, message.seq), page.cursor)
    void perform(() => gateway.acknowledge({ sessionId, workspaceId, channel, throughSeq }), t('acknowledged'))
  }

  const switchChannel = (next: 'local' | 'direct'): void => {
    setChannel(next)
    setPeer('')
    setWorkspaceWide(false)
    setBody('')
    setError('')
    setStatus('')
  }
  const canSend = body.trim() !== '' && (channel === 'direct'
    ? target !== undefined
    : workspaceWide || target !== undefined)

  return (
    <div className={styles.shell} data-agent-mail="authorized">
      <aside className={styles.sidebar} aria-label={t('title')}>
        <div className={styles.brand}><span className={styles.brandMark}>✦</span>{t('title')}</div>
        <nav className={styles.channels} aria-label={t('channelsLabel')}>
          {(['local', 'direct'] as const).map(candidate => (
            <button
              key={candidate}
              type="button"
              className={channel === candidate ? styles.channelActive : styles.channel}
              aria-current={channel === candidate ? 'page' : undefined}
              aria-label={t(candidate === 'local' ? 'channelGeneral' : 'channelDirect')}
              onClick={() => { switchChannel(candidate) }}
            >
              <span className={styles.hash}>#</span>
              <span className={styles.channelName}>{t(candidate === 'local' ? 'channelGeneral' : 'channelDirect')}</span>
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
          <button type="button" className={styles.readButton} disabled={busy || messages.length === 0}
            onClick={acknowledge}>{t('markRead')}</button>
        </header>
        <ol className={styles.feed} aria-label={t(channel === 'local' ? 'localInbox' : 'directInbox')}>
          {messages.length === 0 && <li className={styles.empty}>{t('emptyChannel')}</li>}
          {messages.map((message, index) => {
            const previous = messages[index - 1]
            const grouped = previous !== undefined && previous.from === message.from
              && message.at - previous.at < 5 * 60_000
            return (
              <li key={message.seq} className={grouped ? styles.grouped : styles.message}>
                {grouped ? <span className={styles.avatarSpacer} /> : <AgentAvatar id={message.from} />}
                <div className={styles.messageBody}>
                  {!grouped && (
                    <div className={styles.messageHead}>
                      <strong className={styles.author} title={message.from}>
                        {agentDisplayName(message.from)}
                        <span className={styles.tag}>#{agentNameTag(message.from)}</span>
                      </strong>
                      <time className={styles.time} dateTime={new Date(message.at).toISOString()}>{clockText(message.at)}</time>
                      <span className={styles.workspace}>{message.workspaceId}</span>
                    </div>
                  )}
                  <p className={styles.text}>{message.body}</p>
                </div>
              </li>
            )
          })}
        </ol>
        <form className={styles.composer} onSubmit={submit}>
          <label className={styles.srOnly} htmlFor="agent-mail-peer">{t('peerLabel')}</label>
          <select id="agent-mail-peer" className={styles.peer} value={peer}
            disabled={busy || (channel === 'local' && workspaceWide)}
            onChange={(event) => { setPeer(event.target.value) }}>
            <option value="">{channel === 'local' ? t('channelEveryone') : t('selectPeer')}</option>
            {activePeers.map(candidate => (
              <option key={candidate.sessionId} value={candidate.sessionId}>
                {agentDisplayName(candidate.sessionId)} #{agentNameTag(candidate.sessionId)}
              </option>
            ))}
          </select>
          {channel === 'local' && (
            <label className={styles.wide}>
              <input type="checkbox" checked={workspaceWide} disabled={busy}
                onChange={(event) => { setWorkspaceWide(event.target.checked) }} />
              {t('workspaceWide')}
            </label>
          )}
          <label className={styles.srOnly} htmlFor="agent-mail-body">{t('messageLabel')}</label>
          <textarea id="agent-mail-body" className={styles.input} value={body} disabled={busy} maxLength={65536}
            placeholder={t('composePlaceholder')}
            onChange={(event) => { setBody(event.target.value) }} />
          <button type="submit" className={styles.send} disabled={busy || !canSend}>{t('sendButton')}</button>
        </form>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {status && <p className={styles.status} role="status">{status}</p>}
      </section>
    </div>
  )
}
