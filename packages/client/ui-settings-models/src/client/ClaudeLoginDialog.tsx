/**
 * Claude subscription login dialog: the in-app face of the server-side
 * paste-back flow (`claudeOAuth.*`). Shows the browser approval link,
 * collects the pasted code, and persists through the credentials seam — the
 * same flow as `dsh claude-login`, without leaving the page. Unlike the
 * device flow there is nothing to poll: submitting the paste redeems it on
 * the spot. Token material never reaches this component: snapshots carry
 * progress and outcome only.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Credential reference holding the Claude OAuth subscription session. */
const OAUTH_REF = 'CLAUDE_CODE_OAUTH'

/** Props of {@link ClaudeLoginDialog}. */
export interface ClaudeLoginDialogProps {
  /** Wire faces for session state and the login flow. */
  api: Pick<IApiClient, 'credentials' | 'claudeOAuth'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Close the dialog; `changed` reports whether the session changed. */
  onClose: (changed: boolean) => void
}

type Phase =
  | 'checking'
  | 'idle'
  | 'active'
  | 'starting'
  | 'pending'
  | 'finishing'
  | 'done'
  | 'failed'
  | 'logging-out'

/**
 * Render the subscription login dialog, driving the server-side paste-back
 * flow to completion or cancellation. Unmounting mid-flow cancels the server
 * login.
 */
export function ClaudeLoginDialog(props: ClaudeLoginDialogProps): ReactNode {
  const { api, t, readOnly, onClose } = props
  const [phase, setPhase] = useState<Phase>('checking')
  const [loginId, setLoginId] = useState<string | undefined>(undefined)
  const [verificationUri, setVerificationUri] = useState<string | undefined>(undefined)
  const [pasted, setPasted] = useState('')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const changed = useRef(false)
  const liveLogin = useRef<string | undefined>(undefined)

  // Abandon the server login when this dialog goes away mid-flow.
  useEffect(() => () => {
    if (liveLogin.current !== undefined) {
      void api.claudeOAuth.cancel({ loginId: liveLogin.current }).catch(() => {})
    }
  }, [api])

  // Opening state: a stored session means the subscription is already logged in.
  useEffect(() => {
    let cancelled = false
    void api.credentials.describe({ refs: [OAUTH_REF] })
      .then((response) => {
        if (cancelled) return
        if (!response.result.ok) {
          setFailure(response.result.error.message)
          setPhase('idle')
          return
        }
        setPhase(response.result.value.credentials[OAUTH_REF]?.configured === true ? 'active' : 'idle')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setFailure(messageOf(error))
        setPhase('idle')
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const begin = (): void => {
    setBusy(true)
    setFailure(undefined)
    void api.claudeOAuth.start({})
      .then((response) => {
        if (!response.result.ok) {
          setFailure(response.result.error.message)
          setPhase('failed')
          return
        }
        const login = response.result.value.login
        setLoginId(login.loginId)
        liveLogin.current = login.loginId
        setVerificationUri(login.verificationUri)
        setPasted('')
        setPhase('pending')
      })
      .catch((error: unknown) => {
        setFailure(messageOf(error))
        setPhase('failed')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const submit = (): void => {
    if (loginId === undefined) return
    setBusy(true)
    setFailure(undefined)
    void api.claudeOAuth.submit({ loginId, pasted })
      .then((response) => {
        if (!response.result.ok) {
          setFailure(response.result.error.message)
          setPhase('failed')
          return
        }
        if (response.result.value.login.status !== 'done') {
          setFailure(response.result.value.login.error ?? response.result.value.login.status)
          setPhase('failed')
          return
        }
        changed.current = true
        liveLogin.current = undefined
        setPhase('done')
      })
      .catch((error: unknown) => {
        setFailure(messageOf(error))
        setPhase('failed')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const abort = (): void => {
    if (loginId === undefined) return
    setBusy(true)
    void api.claudeOAuth.cancel({ loginId })
      .catch(() => {})
      .finally(() => {
        liveLogin.current = undefined
        setBusy(false)
        setPhase('idle')
      })
  }

  const logout = (): void => {
    setBusy(true)
    setFailure(undefined)
    void api.credentials.unset({ ref: OAUTH_REF })
      .then((response) => {
        if (!response.result.ok) {
          setFailure(response.result.error.message)
          return
        }
        changed.current = true
        onClose(true)
      })
      .catch((error: unknown) => {
        setFailure(messageOf(error))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const disabled = readOnly || busy
  let body: ReactNode
  let footer: ReactNode
  if (phase === 'checking' || phase === 'starting' || phase === 'finishing') {
    body = null
    footer = null
  } else if (phase === 'active') {
    body = <p>{t('claudeLoginActive')}</p>
    footer = (
      <>
        <Button variant="outline" disabled={disabled} onClick={logout}>
          {t('claudeLoginLogout')}
        </Button>
        <Button variant="outline" disabled={disabled} onClick={begin}>
          {t('claudeLoginRelogin')}
        </Button>
      </>
    )
  } else if (phase === 'idle' || phase === 'failed') {
    body = (
      <>
        <p>{t('claudeLoginIntro')}</p>
        {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      </>
    )
    footer = (
      <Button variant="outline" autoFocus disabled={disabled} onClick={begin}>
        {t('claudeLogin')}
      </Button>
    )
  } else if (phase === 'pending') {
    body = (
      <>
        <p>{t('claudeLoginCodeHint')}</p>
        <p>
          <a href={verificationUri ?? ''} target="_blank" rel="noreferrer">{t('claudeLoginOpenLink')}</a>
        </p>
        <label>
          {t('claudeLoginPasteLabel')}
          <input
            type="text"
            value={pasted}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setPasted(event.target.value)
            }}
          />
        </label>
        {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      </>
    )
    footer = (
      <>
        <Button variant="outline" disabled={disabled} onClick={abort}>
          {t('claudeLoginCancelLogin')}
        </Button>
        <Button
          variant="outline"
          autoFocus
          disabled={disabled || pasted.trim().length === 0}
          onClick={submit}
        >
          {t('claudeLoginSubmit')}
        </Button>
      </>
    )
  } else {
    body = <p>{t('claudeLoginDone')}</p>
    footer = (
      <Button
        variant="outline"
        autoFocus
        onClick={() => {
          onClose(changed.current)
        }}
      >
        {t('close')}
      </Button>
    )
  }

  return (
    <Modal
      open
      onClose={() => {
        onClose(changed.current)
      }}
      title={t('claudeLoginTitle')}
      closeLabel={t('close')}
      footer={footer}
    >
      {body}
    </Modal>
  )
}
