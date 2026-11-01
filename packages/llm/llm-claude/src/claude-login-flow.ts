/**
 * Server-side Claude subscription login flow for non-CLI surfaces (the
 * in-app login button). Unlike the Zen device flow, Claude uses browser
 * code paste-back: `start` issues the approval link, the operator approves
 * and pastes the shown code into the UI, and `submit` redeems it on the
 * spot — no background polling, no workspace pick. Token material never
 * leaves the process; snapshots carry progress and outcome only.
 *
 * Single writer preserved: persistence goes through the injected credential
 * sink (the harness credentials seam in production), the same seam the CLI
 * and the per-request refresh use.
 *
 * @module dsh-llm-claude/claude-login-flow
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  ClaudeOAuthError,
  createAuthorizeFlow,
  exchangeCode,
  isAccessValid,
  parseOAuthState,
  type ClaudeAuthorizeFlow,
} from './claude-oauth.ts'
import type { OAuthCredentialSource } from './claude-oauth.ts'

/** Context key this manager is provided under; consumers read it via `ctx.get`. */
export const CLAUDE_OAUTH_SERVICE = 'claudeOAuth'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Pending Claude subscription logins; present while `llm-claude` is installed. */
    claudeOAuth?: ClaudeLoginFlow
  }
}

/** UI-visible login phase; terminal phases settle the record. */
export type ClaudeLoginPhase = 'pending' | 'done' | 'failed' | 'cancelled'

/**
 * UI-safe login view: progress and outcome only. The PKCE verifier, pasted
 * codes, and tokens never appear here.
 */
export interface ClaudeLoginSnapshot {
  /** Server-minted login id for the submit/cancel calls. */
  loginId: string
  /** Current phase. */
  status: ClaudeLoginPhase
  /** Browser link; present while pending. */
  verificationUri?: string
  /** Terminal failure wording; present on failure. */
  error?: string
}

/** Constructor dependencies; getters stay live so settings changes apply. */
export interface ClaudeLoginFlowOptions {
  /** Read the credentials service; absent means logged-out-only operation. */
  credentialsOf: () => OAuthCredentialSource | undefined
  /** Persist one value; the harness credentials seam in production. */
  store: (ref: CredentialRef, value: string) => Promise<void>
  /** Current validated OAuth credential reference. */
  oauthRefOf: () => CredentialRef
  /** Console root override for the token endpoint (tests and advanced deployments). */
  consoleBase?: string
  /** Approval-link override for tests (defaults to the account IdP). */
  authorizeUrl?: string
}

/** Internal record: public snapshot fields plus the redeem secrets. */
interface LoginRecord {
  readonly id: string
  readonly flow: ClaudeAuthorizeFlow
  status: ClaudeLoginPhase
  failure?: string
  updatedAt: number
}

/** Cap on concurrent pending logins; pastes expire server-side anyway. */
const MAX_PENDING_LOGINS = 5
/** Cap on retained records; terminal ones evict oldest-first. */
const MAX_RECORDS = 32

function terminalOf(status: ClaudeLoginPhase): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

/**
 * Server-side Claude subscription logins for UI surfaces. One instance per
 * plugin install; safe for concurrent logins and fiber disposal.
 */
export class ClaudeLoginFlow {
  readonly #options: ClaudeLoginFlowOptions
  readonly #records = new Map<string, LoginRecord>()

  constructor(options: ClaudeLoginFlowOptions) {
    this.#options = options
  }

  /**
   * Start one login: build the browser approval link immediately. The
   * operator approves out of band and pastes the shown code back through
   * {@link submit}.
   */
  start(): ClaudeLoginSnapshot {
    this.prune()
    const pending = [...this.#records.values()].filter(record => !terminalOf(record.status)).length
    if (pending >= MAX_PENDING_LOGINS) {
      throw new ClaudeOAuthError('too many pending Claude logins; cancel one and try again')
    }
    const flow = createAuthorizeFlow(
      this.#options.authorizeUrl === undefined ? undefined : { authorizeUrl: this.#options.authorizeUrl },
    )
    const record: LoginRecord = {
      id: `login_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      flow,
      status: 'pending',
      updatedAt: Date.now(),
    }
    this.#records.set(record.id, record)
    return this.snapshotOrThrow(record.id)
  }

  /** UI-safe view of one login; `undefined` for unknown ids. */
  snapshot(loginId: string): ClaudeLoginSnapshot | undefined {
    const record = this.#records.get(loginId)
    if (record === undefined) return undefined
    const view: ClaudeLoginSnapshot = { loginId: record.id, status: record.status }
    if (record.status === 'pending') view.verificationUri = record.flow.authorizeUrl
    if (record.failure !== undefined) view.error = record.failure
    return view
  }

  /** {@link snapshot}, throwing if the just-created or just-updated record is somehow missing. */
  private snapshotOrThrow(loginId: string): ClaudeLoginSnapshot {
    const view = this.snapshot(loginId)
    if (view === undefined) throw new ClaudeOAuthError(`Claude login record ${loginId} vanished`)
    return view
  }

  /**
   * Redeem one pasted `{code}#{state}` (or bare code) and persist the
   * session. Only valid while pending; the state half must match this
   * login's minted state when present.
   */
  async submit(loginId: string, pasted: string): Promise<ClaudeLoginSnapshot> {
    const record = this.#records.get(loginId)
    if (record === undefined) throw new ClaudeOAuthError(`unknown Claude login "${loginId}"`)
    if (record.status !== 'pending') {
      throw new ClaudeOAuthError(`Claude login "${loginId}" is ${record.status}; no paste is open`)
    }
    const text = pasted.trim()
    if (text.length === 0) throw new ClaudeOAuthError('Claude login failed: pasted code is empty')
    const hash = text.indexOf('#')
    const code = (hash === -1 ? text : text.slice(0, hash)).trim()
    const state = hash === -1 ? undefined : text.slice(hash + 1).trim()
    if (code.length === 0) throw new ClaudeOAuthError('Claude login failed: pasted code is empty')
    if (state !== undefined && state !== record.flow.state) {
      throw new ClaudeOAuthError('Claude login failed: the pasted code is not for this login attempt; start over')
    }
    let tokens
    try {
      tokens = await exchangeCode(code, record.flow.verifier, {
        state: state ?? record.flow.state,
        ...(this.#options.consoleBase === undefined ? {} : { consoleBase: this.#options.consoleBase }),
      })
    } catch (error: unknown) {
      record.status = 'failed'
      record.failure = error instanceof Error ? error.message : String(error)
      record.updatedAt = Date.now()
      throw error
    }
    const stored: { access: string; refresh?: string; expiresAt: number } = { ...tokens }
    await this.#options.store(this.#options.oauthRefOf(), JSON.stringify(stored))
    record.status = 'done'
    record.updatedAt = Date.now()
    return this.snapshotOrThrow(record.id)
  }

  /**
   * Abandon one login. Unknown ids yield `undefined`; terminal logins report
   * their current view.
   */
  cancel(loginId: string): ClaudeLoginSnapshot | undefined {
    const record = this.#records.get(loginId)
    if (record === undefined) return undefined
    if (!terminalOf(record.status)) {
      record.status = 'cancelled'
      record.updatedAt = Date.now()
    }
    return this.snapshot(loginId)
  }

  /** Settle every pending login as cancelled; fiber teardown calls this. */
  dispose(): void {
    for (const record of this.#records.values()) {
      if (!terminalOf(record.status)) {
        record.status = 'cancelled'
        record.updatedAt = Date.now()
      }
    }
  }

  /**
   * Whether a usable session exists right now (valid stored token). Lets a
   * UI show state without starting a flow; never exposes the token.
   */
  async hasSession(): Promise<boolean> {
    const source = this.#options.credentialsOf()
    if (source === undefined) return false
    let raw: string | undefined
    try {
      raw = (await source.resolve(this.#options.oauthRefOf()))?.value
    } catch {
      return false
    }
    const state = parseOAuthState(raw)
    return state !== undefined && isAccessValid(state)
  }

  private prune(): void {
    if (this.#records.size < MAX_RECORDS) return
    const terminal = [...this.#records.values()]
      .filter(record => terminalOf(record.status))
      .sort((left, right) => left.updatedAt - right.updatedAt)
    for (const record of terminal.slice(0, this.#records.size - MAX_RECORDS + 1)) {
      this.#records.delete(record.id)
    }
  }
}
