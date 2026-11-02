import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { ChatSnapshot, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentMailGateway } from './gateway.ts'
import { agentDisplayName, agentInitials, agentNameTag } from './agent-names.ts'
import {
  agentMailChannel, setAgentMailChannel, subscribeAgentMailChannel, type AgentMailChannel,
} from './composer-targets.ts'
import { agentMailSent, subscribeAgentMailSent } from './sent-log.ts'
import styles from './AgentMailConversationView.module.css'

export type AgentMailConversationViewProps = ConvViewProps & PropsLocale<'conversation.agentMail'> & {
  gateway?: AgentMailGateway
}

type Authorization = ReturnType<AgentMailGateway['authorization']>
type Inbox = ReturnType<AgentMailGateway['inbox']>

/** One rendered feed row: queued mail or an outgoing `send_message` call. */
interface FeedEntry {
  readonly key: string
  readonly from: string
  readonly to?: readonly string[]
  readonly workspaceId: string
  readonly body: string
  readonly at: number
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

/** One call head from a running or settled tool row. */
function callHead(block: ToolCallBlock): { callId: string; name: string; argsRaw: string; at: number } | undefined {
  if ('kind' in block) {
    return block.call === null
      ? undefined
      : { callId: block.callId, name: block.call.name, argsRaw: block.call.argsRaw, at: block.callTime ?? block.time }
  }
  return { callId: block.callId, name: block.name, argsRaw: block.argsRaw, at: block.time }
}

/**
 * Project the current agent's `send_message` tool calls into feed rows. The
 * recipient answers through a subagent report, which already lands in Agent
 * Mail, so one thread holds both directions without exposing the tool call as
 * opaque JSON.
 * @param chat - active session chat snapshot.
 * @param from - the current agent session id.
 * @returns outgoing relay rows in call order.
 */
function collectRelays(chat: ChatSnapshot, from: string): readonly FeedEntry[] {
  const entries: FeedEntry[] = []
  for (const node of chat.nodes.values()) {
    if (node.kind !== 'tool-call') continue
    const root = (node.data as { root?: ToolCallBlock }).root
    if (root === undefined) continue
    const head = callHead(root)
    if (head === undefined || head.name !== 'send_message') continue
    let args: unknown
    try { args = JSON.parse(head.argsRaw) } catch { continue }
    if (typeof args !== 'object' || args === null) continue
    const { subagent_id: to, message } = args as { subagent_id?: unknown; message?: unknown }
    if (typeof to !== 'string' || typeof message !== 'string' || message === '') continue
    entries.push({ key: `relay:${head.callId}`, from, to: [to], workspaceId: '', body: message, at: head.at })
  }
  return entries
}

function AuthorizedMail({ gateway, sessionId, workspaceId, t, useSession }: AgentMailConversationViewProps & {
  gateway: AgentMailGateway
  sessionId: NonNullable<AgentMailConversationViewProps['sessionId']>
  workspaceId: string
}): React.JSX.Element {
  const subscribeChannel = useCallback(
    (listener: () => void) => subscribeAgentMailChannel(sessionId, listener),
    [sessionId],
  )
  const readChannel = useCallback((): AgentMailChannel => agentMailChannel(sessionId), [sessionId])
  const channel = useSyncExternalStore(subscribeChannel, readChannel)
  const subscribeSent = useCallback(
    (listener: () => void) => subscribeAgentMailSent(sessionId, listener),
    [sessionId],
  )
  const readSent = useCallback(() => agentMailSent(sessionId), [sessionId])
  const sent = useSyncExternalStore(subscribeSent, readSent)
  const [inbox, setInbox] = useState<Inbox>(() => gateway.inbox(sessionId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const chat = useSession(snapshot => snapshot.chat)
  const relays = useMemo(() => collectRelays(chat, sessionId), [chat, sessionId])
  useEffect(() => {
    const refresh = (): void => { setInbox({ ...gateway.inbox(sessionId) }) }
    const unsubscribe = gateway.subscribeInbox(refresh)
    refresh() // close the subscription race; never acknowledge merely by displaying
    return unsubscribe
  }, [gateway, sessionId])

  const page = inbox[channel]
  const messages = page.messages
  const feed = useMemo(() => {
    const rows: FeedEntry[] = messages.map(message => ({
      key: `mail:${message.seq}`,
      from: message.from,
      workspaceId: message.workspaceId,
      body: message.body,
      at: message.at,
    }))
    const sentRows: FeedEntry[] = sent
      .filter(entry => entry.channel === channel)
      .map(entry => ({
        key: entry.key, from: entry.from, to: entry.to, workspaceId: '', body: entry.body, at: entry.at,
      }))
    return [...rows, ...(channel === 'local' ? relays : []), ...sentRows]
      .sort((left, right) => left.at - right.at)
  }, [channel, messages, relays, sent])
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

  const acknowledge = (): void => {
    const throughSeq = messages.reduce((highest, message) => Math.max(highest, message.seq), page.cursor)
    void perform(() => gateway.acknowledge({ sessionId, workspaceId, channel, throughSeq }), t('acknowledged'))
  }

  const switchChannel = (next: AgentMailChannel): void => {
    setAgentMailChannel(sessionId, next)
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
        <p className={styles.composerHint}>{t('composerHint')}</p>
        <ol className={styles.feed} aria-label={t(channel === 'local' ? 'localInbox' : 'directInbox')}>
          {feed.length === 0 && <li className={styles.empty}>{t('emptyChannel')}</li>}
          {feed.map((message, index) => {
            const previous = feed[index - 1]
            const grouped = previous !== undefined && previous.from === message.from
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
                </div>
              </li>
            )
          })}
        </ol>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {status && <p className={styles.status} role="status">{status}</p>}
      </section>
    </div>
  )
}
