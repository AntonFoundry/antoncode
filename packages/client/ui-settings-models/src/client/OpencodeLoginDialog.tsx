/**
 * OpenCode workspace login dialog: the in-app face of the server-side device
 * flow (`opencodeOAuth.*`). Shows the browser code and link, polls for the
 * approval, offers the workspace pick, and persists through the credentials
 * seam — the same flow as `dsh opencode-login`, without leaving the page.
 * Token material never reaches this component: snapshots carry progress and
 * outcome only.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { failureMessage } from './operations.ts'
import type { ModelsOperations, OpencodeLoginOperations, OpencodeLoginOrg } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Credential reference holding the Zen OAuth workspace session. */
const OAUTH_REF = 'OPENCODE_ZEN_OAUTH'

/** Props of {@link OpencodeLoginDialog}. */
export interface OpencodeLoginDialogProps {
  /** Credential operations reading and dropping the stored session. */
  operations: Pick<ModelsOperations, 'describeCredential' | 'removeCredential'>
  /** Host device-flow operations. */
  login: OpencodeLoginOperations
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
  | 'awaiting-org'
  | 'finishing'
  | 'done'
  | 'failed'
  | 'logging-out'

/**
 * Render the workspace login dialog, driving the server-side device flow to
 * completion or cancellation. Unmounting mid-flow cancels the server login.
 */
export function OpencodeLoginDialog(props: OpencodeLoginDialogProps): ReactNode {
  const { operations, login: flow, t, readOnly, onClose } = props
  const [phase, setPhase] = useState<Phase>('checking')
  const [loginId, setLoginId] = useState<string | undefined>(undefined)
  const [userCode, setUserCode] = useState<string | undefined>(undefined)
  const [verificationUri, setVerificationUri] = useState<string | undefined>(undefined)
  const [orgs, setOrgs] = useState<readonly OpencodeLoginOrg[]>([])
  const [pickedOrg, setPickedOrg] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const changed = useRef(false)
  const liveLogin = useRef<string | undefined>(undefined)
  const polling = useRef(false)

  // Abandon the server login when this dialog goes away mid-flow.
  useEffect(() => () => {
    if (liveLogin.current !== undefined) {
      // The dialog is gone, so a refused or rejected cancel has nowhere to be reported.
      void flow.cancel(liveLogin.current).catch(() => {})
    }
  }, [flow])

  // Opening state: a stored session means the workspace is already logged in.
  useEffect(() => {
    let cancelled = false
    void operations.describeCredential(OAUTH_REF)
      .then((outcome) => {
        if (cancelled) return
        if (outcome.kind === 'refused') {
          setFailure(outcome.message)
          setPhase('idle')
          return
        }
        setPhase(outcome.configured ? 'active' : 'idle')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setFailure(failureMessage(error))
        setPhase('idle')
      })
    return () => {
      cancelled = true
    }
  }, [operations])

  // Approval wait: single-flight polls until the server settles the login.
  useEffect(() => {
    if (phase !== 'pending' || loginId === undefined) return
    const timer = setInterval(() => {
      if (polling.current) return
      polling.current = true
      void flow.status(loginId)
        .then((outcome) => {
          if (outcome.kind === 'refused') {
            setFailure(outcome.message)
            setPhase('failed')
            return
          }
          const login = outcome.login
          if (login.status === 'awaiting-org') {
            setOrgs(login.orgs ?? [])
            setPhase('awaiting-org')
          } else if (login.status === 'done') {
            changed.current = true
            liveLogin.current = undefined
            setPhase('done')
          } else if (login.status === 'denied' || login.status === 'expired' || login.status === 'cancelled') {
            setFailure(login.error ?? login.status)
            setPhase('failed')
          }
        })
        .catch((error: unknown) => {
          setFailure(failureMessage(error))
          setPhase('failed')
        })
        .finally(() => {
          polling.current = false
        })
    }, 2000)
    return () => {
      clearInterval(timer)
    }
  }, [flow, phase, loginId])

  const begin = (): void => {
    setBusy(true)
    setFailure(undefined)
    void flow.start()
      .then((outcome) => {
        if (outcome.kind === 'refused') {
          setFailure(outcome.message)
          setPhase('failed')
          return
        }
        const login = outcome.login
        setLoginId(login.loginId)
        liveLogin.current = login.loginId
        setUserCode(login.userCode)
        setVerificationUri(login.verificationUri)
        setPhase('pending')
      })
      .catch((error: unknown) => {
        setFailure(failureMessage(error))
        setPhase('failed')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const confirmOrg = (): void => {
    if (loginId === undefined) return
    setBusy(true)
    setFailure(undefined)
    void flow.select(loginId, pickedOrg)
      .then((outcome) => {
        if (outcome.kind === 'refused') {
          setFailure(outcome.message)
          setPhase('failed')
          return
        }
        changed.current = true
        liveLogin.current = undefined
        setPhase('done')
      })
      .catch((error: unknown) => {
        setFailure(failureMessage(error))
        setPhase('failed')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const abort = (): void => {
    if (loginId === undefined) return
    setBusy(true)
    // Cancel is idempotent and the dialog returns to idle either way.
    void flow.cancel(loginId)
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
    void operations.removeCredential(OAUTH_REF)
      .then((refusal) => {
        if (refusal !== undefined) {
          setFailure(refusal)
          return
        }
        changed.current = true
        onClose(true)
      })
      .catch((error: unknown) => {
        setFailure(failureMessage(error))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const disabled = readOnly || busy
  let body: ReactNode
  let footer: ReactNode
  if (phase === 'checking' || phase === 'starting') {
    body = null
    footer = null
  } else if (phase === 'active') {
    body = <p>{t('opencodeLoginActive')}</p>
    footer = (
      <>
        <Button variant="outline" disabled={disabled} onClick={logout}>
          {t('opencodeLoginLogout')}
        </Button>
        <Button variant="outline" disabled={disabled} onClick={begin}>
          {t('opencodeLoginRelogin')}
        </Button>
      </>
    )
  } else if (phase === 'idle' || phase === 'failed') {
    body = (
      <>
        <p>{t('opencodeLoginIntro')}</p>
        {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      </>
    )
    footer = (
      <Button variant="outline" autoFocus disabled={disabled} onClick={begin}>
        {t('opencodeLogin')}
      </Button>
    )
  } else if (phase === 'pending') {
    body = (
      <>
        <p>{t('opencodeLoginCodeHint')}</p>
        <p><strong>{userCode ?? ''}</strong></p>
        <p>
          <a href={verificationUri ?? ''} target="_blank" rel="noreferrer">{t('opencodeLoginOpenLink')}</a>
        </p>
        <p>{t('opencodeLoginWaiting')}</p>
      </>
    )
    footer = (
      <Button variant="outline" disabled={disabled} onClick={abort}>
        {t('opencodeLoginCancelLogin')}
      </Button>
    )
  } else if (phase === 'awaiting-org') {
    body = (
      <>
        <p>{t('opencodeLoginPickWorkspace')}</p>
        {orgs.map(org => (
          <label key={org.id}>
            <input
              type="radio"
              name="opencode-org"
              checked={pickedOrg === org.id}
              disabled={disabled}
              onChange={() => {
                setPickedOrg(org.id)
              }}
            />
            {org.name}
          </label>
        ))}
      </>
    )
    footer = (
      <>
        <Button variant="outline" disabled={disabled} onClick={abort}>
          {t('opencodeLoginCancelLogin')}
        </Button>
        <Button variant="outline" autoFocus disabled={disabled} onClick={confirmOrg}>
          {pickedOrg === undefined ? t('opencodeLoginSkipWorkspace') : t('opencodeLoginConfirm')}
        </Button>
      </>
    )
  } else {
    body = <p>{t('opencodeLoginDone')}</p>
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
      title={t('opencodeLoginTitle')}
      closeLabel={t('close')}
      footer={footer}
    >
      {body}
    </Modal>
  )
}
