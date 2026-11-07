/** Sent-message tail removal creates a new conversation; it never edits the source. */
import { useRef, useState } from 'react'
import { IconEllipsisOutlineRegular, Menu, RiskConfirmation, Tooltip, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './MessageIconActions.module.css'

/** Session-bound callback supplied only to the official sent-message renderer. */
export interface SentMessageActionsInjected {
  /** Fork before this durable message and open the child; failures are reported by the overlay. */
  removeFrom: (seq: number) => Promise<void>
  /** Report an unexpected rejected operation through the frame-wide notice. */
  reportRemoveFailure: (error: unknown) => void
}

/** One settled outcome, retained outside the source conversation panel. */
export interface MessageActionNotice {
  readonly seq: number
  readonly outcome: 'created' | 'failed' | 'titleFailed'
}

/** Frame-wide sent-message operation feedback. */
export interface MessageActionNoticeInjected {
  hooks: { messageActionNotice: HostObservable<MessageActionNotice | null> }
  dismissMessageActionNotice: () => void
}

/**
 * Render settled operation feedback independently of the conversation being left.
 * @param props - Live notice, dismissal callback and locale seat.
 * @returns A shared Toast while an outcome is visible.
 */
export function MessageActionNoticeHost({ useMessageActionNotice, dismissMessageActionNotice, t }:
  PropsRuntime<'shell.overlay'> & PropsLocale<'chat'> & InjectFace<MessageActionNoticeInjected>) {
  const notice = useMessageActionNotice(value => value)
  return notice === null ? null : <Toast key={notice.seq} text={t(`message.remove.${notice.outcome}`)}
    {...notice.outcome === 'created' ? { tone: 'success' as const } : {}}
    onDone={dismissMessageActionNotice} />
}

/**
 * Render copy and the confirmed fork-before-message menu for a durable sent row.
 * @param props - Message identity and text, live availability, fork callback and locale seat.
 * @returns Sent-message actions and their controlled confirmation.
 */
export function SentMessageActions({ node, text, removeFrom, reportRemoveFailure, useSession, useAccess, t, className }:
  Pick<ChatNodeViewProps<'user' | 'steering'>, 'node' | 'useSession' | 'useAccess' | 't'>
  & SentMessageActionsInjected & { text: string; className?: string | undefined }) {
  const running = useSession(snapshot => snapshot.running || snapshot.removed)
  const allowed = useAccess('session/fork')
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const durable = node.data.messageId !== undefined && Number.isSafeInteger(node.data.seq) && node.data.seq > 0
  const unavailable = running || pending
  const cancel = () => { if (!inFlight.current) setConfirming(false) }
  const confirm = () => {
    if (!acknowledged || unavailable || !allowed || inFlight.current) return
    inFlight.current = true
    setPending(true)
    void removeFrom(node.data.seq).catch(reportRemoveFailure).finally(() => {
      inFlight.current = false
      setPending(false)
      setConfirming(false)
    })
  }
  return <>
    <MessageIconActions text={text} time={node.data.time} clock="start" className={className} t={t}
      extraActions={allowed && durable ? <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} portal autoFocus
        items={[{ id: 'remove', label: t('message.remove.action'), disabled: unavailable }]}
        onSelect={() => { setMenuOpen(false); setAcknowledged(false); setConfirming(true) }}
        anchor={<Tooltip label={t('message.more')} side="bottom"><button type="button" className={css.action}
          aria-label={t('message.more')} aria-haspopup="menu" aria-expanded={menuOpen}
          onClick={() => { setMenuOpen(value => !value) }}><IconEllipsisOutlineRegular /></button></Tooltip>} /> : null} />
    <RiskConfirmation open={confirming} title={t('message.remove.title')} description={t('message.remove.description')}
      acknowledgeLabel={t('message.remove.acknowledge')} cancelLabel={t('cancel')} closeLabel={t('close')}
      confirmLabel={t('message.remove.confirm')} acknowledged={acknowledged} disabled={unavailable || !allowed}
      onAcknowledgedChange={setAcknowledged} onCancel={cancel} onConfirm={confirm} />
  </>
}
