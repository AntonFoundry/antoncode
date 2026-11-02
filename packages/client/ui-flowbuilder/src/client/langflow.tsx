/**
 * The Workflows tab embed: the local LangFlow server's UI in a full-tab
 * iframe, with a slim control bar (state pill, Start/Stop/Open) and explicit
 * stopped / starting / error states. Pure presentation over the inject face —
 * every lifecycle call arrives through the `actions` callbacks.
 */
import { createElement, useCallback, useEffect, useState } from 'react'
import type { FC } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { LangflowStatus as LangflowStatusView } from '@deepseek-ai/dsh-api-remotes/client'
import type { FlowbuilderKey } from './locales.ts'
import styles from './langflow.module.css'

/** Chrome copy, rebuilt per inject so it follows the active locale. */
export interface LangflowLabels {
  /** Translate one dictionary key. */
  t: (key: FlowbuilderKey) => string
}

/** The callbacks the plugin injects: the complete langflow.* lifecycle surface. */
export interface LangflowActions {
  /** Snapshot the sidecar state; safe to call on mount. */
  status(): Promise<LangflowStatusView>
  /** Spawn the child and resolve at readiness (or the startup failure). */
  start(): Promise<LangflowStatusView>
  /** Terminate the child tree; resolves the resulting stopped status. */
  stop(): Promise<LangflowStatusView>
}

/** Inject face: chrome copy plus the actions. */
export interface LangflowInjected {
  labels: LangflowLabels
  actions: LangflowActions
}

/** Component props: the slot's standard share plus the inject face. */
export type LangflowViewProps = ConvViewProps & LangflowInjected

/** The in-flight lifecycle call, if any (drives button disabling). */
type Busy = 'start' | 'stop'

/**
 * The Workflows view.
 * @param props - inject face (labels, actions).
 * @returns The LangFlow embed.
 */
export const LangflowView: FC<LangflowViewProps> = ({ labels, actions }) => {
  const { t } = labels
  const [status, setStatus] = useState<LangflowStatusView | undefined>(undefined)
  const [busy, setBusy] = useState<Busy | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  // Initial snapshot on mount; the embed must not guess whether the sidecar
  // is already serving (the app may have started it in an earlier visit).
  useEffect(() => {
    let alive = true
    actions.status()
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [actions])

  const start = useCallback(() => {
    setBusy('start')
    setError(undefined)
    // Optimistic: the RPC resolves only at readiness, which can take minutes
    // on a first uvx download; the pill must show the attempt immediately.
    setStatus({ state: 'starting' })
    actions.start()
      .then((s) => {
        setStatus(s)
        setBusy(undefined)
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setBusy(undefined)
      })
  }, [actions])

  const stop = useCallback(() => {
    setBusy('stop')
    actions.stop()
      .then((s) => {
        setStatus(s)
        setBusy(undefined)
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setBusy(undefined)
      })
  }, [actions])

  const state = status?.state ?? 'stopped'
  const running = state === 'running' && status?.url !== undefined
  const stateLabel = t(`langflow.state.${state}` as FlowbuilderKey)
  return (
    createElement('div', { className: styles.shell },
      createElement('div', { className: styles.toolbar },
        createElement('span', {
          className: state === 'running'
            ? `${styles.pill} ${styles.pillRunning}`
            : state === 'error' ? `${styles.pill} ${styles.pillError}` : styles.pill,
        }, stateLabel),
        createElement('button', {
          className: styles.button,
          onClick: start,
          disabled: busy !== undefined || state === 'running' || state === 'starting',
        }, t('langflow.start')),
        createElement('button', {
          className: styles.button,
          onClick: stop,
          disabled: busy !== undefined || (state !== 'running' && state !== 'starting'),
        }, t('langflow.stop')),
        createElement('span', { className: styles.spacer }),
        running
          ? createElement('a', { className: styles.openLink, href: status?.url, target: '_blank', rel: 'noreferrer' }, t('langflow.open'))
          : null,
      ),
      error !== undefined
        ? createElement('div', { className: styles.errorStrip }, `${t('langflow.load.error')}: ${error}`)
        : null,
      running
        ? createElement('iframe', {
          className: styles.frame,
          src: status?.url,
          title: 'LangFlow',
        })
        : createElement('div', { className: styles.placeholder },
          state === 'error' && status?.error !== undefined
            ? createElement('div', { className: styles.errorStrip }, status.error)
            : null,
          createElement('div', { className: styles.hint }, t('langflow.stopped.hint')),
        ),
    )
  )
}
