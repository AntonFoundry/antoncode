import { useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentMailGateway } from './gateway.ts'

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

function AuthorizedMail({ gateway, sessionId, workspaceId, t }: AgentMailConversationViewProps & {
  gateway: AgentMailGateway
  sessionId: NonNullable<AgentMailConversationViewProps['sessionId']>
  workspaceId: string
}): React.JSX.Element {
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

  const peers = gateway.peers(sessionId).filter(candidate => candidate.sessionId !== sessionId)
  const target = peers.find(candidate => candidate.sessionId === peer)
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
    if (!text || (!workspaceWide && !target)) return
    const operation = (): Promise<void> => {
      if (workspaceWide) return gateway.sendLocal({ sessionId, workspaceId, recipients: [], body: text, workspaceWide: true })
      if (!target) return Promise.resolve()
      return target.workspaceId === workspaceId
        ? gateway.sendLocal({ sessionId, workspaceId, recipients: [target.sessionId], body: text, workspaceWide: false })
        : gateway.sendDirect({ sessionId, workspaceId, recipient: target.sessionId, body: text })
    }
    void perform(operation, t('sent')).then((sent) => {
      if (sent && ready()) setBody('')
    })
  }
  const acknowledge = (channel: 'local' | 'direct', throughSeq: number): void => {
    void perform(() => gateway.acknowledge({ sessionId, workspaceId, channel, throughSeq }), t('acknowledged'))
  }
  return (
    <section aria-labelledby="agent-mail-title" data-agent-mail="authorized">
      <header><h2 id="agent-mail-title">{t('title')}</h2><span>{t('authorized')}</span></header>
      <button type="button" disabled={busy}
        onClick={() => { void perform(() => gateway.refresh(sessionId), t('refreshed')) }}>
        {t('refreshButton')}
      </button>
      <section aria-labelledby="agent-mail-address-title">
        <h3 id="agent-mail-address-title">{t('addressLabel')}</h3><code>{sessionId}</code>
        <p>{t('workspaceLabel')}: <code>{workspaceId}</code></p>
      </section>
      {(['local', 'direct'] as const).map((channel) => {
        const page = inbox[channel]
        const throughSeq = page.messages.reduce((highest, message) => Math.max(highest, message.seq), page.cursor)
        return (
          <section key={channel} aria-label={t(channel === 'local' ? 'localInbox' : 'directInbox')}>
            <h3>{t(channel === 'local' ? 'localInbox' : 'directInbox')}</h3>
            <p>{t('cursorLabel')}: {page.cursor}</p>
            <ol>{page.messages.map(message => (
              <li key={message.seq}>
                <strong>{message.from}</strong> <span>{message.workspaceId}</span>
                <p>{message.body}</p>
                <time dateTime={new Date(message.at).toISOString()}>{new Date(message.at).toLocaleString()}</time>
              </li>
            ))}</ol>
            <button type="button" disabled={busy || throughSeq <= page.cursor}
              onClick={() => { acknowledge(channel, throughSeq) }}>
              {t('acknowledgeButton')}
            </button>
          </section>
        )
      })}
      <form onSubmit={submit} aria-label={t('composeTitle')}>
        <h3>{t('composeTitle')}</h3>
        <label htmlFor="agent-mail-peer">{t('peerLabel')}</label>
        <select id="agent-mail-peer" value={peer} disabled={busy || workspaceWide}
          onChange={(event) => { setPeer(event.target.value) }}>
          <option value="">{t('selectPeer')}</option>
          {peers.map(candidate => (
            <option key={candidate.sessionId} value={candidate.sessionId}>
              {candidate.sessionId} ({candidate.workspaceId === workspaceId ? t('localPeer') : t('directPeer')})
            </option>
          ))}
        </select>
        <label htmlFor="agent-mail-wide">{t('workspaceWide')}</label>
        <input id="agent-mail-wide" type="checkbox" checked={workspaceWide} disabled={busy}
          onChange={(event) => { setWorkspaceWide(event.target.checked) }} />
        <label htmlFor="agent-mail-body">{t('messageLabel')}</label>
        <textarea id="agent-mail-body" value={body} disabled={busy} maxLength={65536}
          onChange={(event) => { setBody(event.target.value) }} />
        <button type="submit" disabled={busy || !body.trim() || (!workspaceWide && !target)}>{t('sendButton')}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <p>{t('noEmail')}</p>
    </section>
  )
}
