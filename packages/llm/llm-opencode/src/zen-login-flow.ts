/**
 * Multi-step Zen OAuth login flow for non-CLI surfaces (the in-app login
 * button). The CLI drives the same device flow inline through
 * {@link runZenLogin}; UI-driven login cannot block on a terminal, so this
 * manager holds pending logins server-side: `start` issues the device code,
 * a background driver polls for the browser approval, `snapshot` reports
 * progress for UI polling, and `select` records the billed workspace and
 * persists the session. Token material never leaves the process — snapshots
 * carry only the user code, link, workspace list, and outcome.
 *
 * Single writer preserved: persistence goes through the injected credential
 * sink (the harness credentials seam in production), the same seam the CLI
 * and the per-request refresh use.
 *
 * @module dsh-llm-opencode/zen-login-flow
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  fetchAllowedModels,
  fetchOrgs,
  isAccessValid,
  LlmOAuthError,
  parseOAuthState,
  pollDeviceToken,
  requestDeviceCode,
  type ZenDeviceCode,
  type ZenOrg,
  type OAuthCredentialSource,
} from './zen-oauth.ts'

/** Context key this manager is provided under; consumers read it via `ctx.get`. */
export const OPENCODE_OAUTH_SERVICE = 'opencodeOAuth'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Pending Zen workspace logins; present while `llm-opencode` is installed. */
    opencodeOAuth?: ZenLoginFlow
  }
}

/** UI-visible login phase; terminal phases settle the record. */
export type ZenLoginPhase = 'pending' | 'awaiting-org' | 'done' | 'denied' | 'expired' | 'cancelled'

/**
 * UI-safe login view: progress and outcome only. Device codes, tokens, and
 * refresh material never appear here.
 */
export interface ZenLoginSnapshot {
  /** Server-minted login id for the poll/select calls. */
  loginId: string
  /** Current phase. */
  status: ZenLoginPhase
  /** Short code the operator types; present while pending. */
  userCode?: string
  /** Browser link; present while pending. */
  verificationUri?: string
  /** Console-advised poll cadence; present while pending. */
  intervalSeconds?: number
  /** Approval window; present while pending. */
  expiresInSeconds?: number
  /** Billable workspaces; present while awaiting the pick. */
  orgs?: ZenOrg[]
  /** Picked workspace id; present once chosen or auto-picked. */
  orgID?: string
  /** Workspace model count snapshotted at completion; present when done. */
  allowedModelCount?: number
  /** Terminal failure wording; present on denial/expiry. */
  error?: string
}

/** Credential write surface the flow persists through. */
export interface ZenLoginCredentialSink {
  /** Durably store one value under a reference. */
  set(ref: CredentialRef, value: string): Promise<void>
}

/** Constructor dependencies; getters stay live so settings changes apply. */
export interface ZenLoginFlowOptions {
  /** Read the credentials service; absent means logged-out-only operation. */
  credentialsOf: () => OAuthCredentialSource | undefined
  /** Persist one value; the harness credentials seam in production. */
  store: (ref: CredentialRef, value: string) => Promise<void>
  /** Current validated OAuth credential reference. */
  oauthRefOf: () => CredentialRef
  /** Console root override (tests and advanced deployments). */
  consoleBase?: string
}

/** Internal record: public snapshot fields plus secrets and the driver. */
interface LoginRecord {
  readonly id: string
  readonly code: ZenDeviceCode
  readonly abort: AbortController
  status: ZenLoginPhase
  tokens?: { access: string; refresh: string; expiresAt: number }
  orgs?: ZenOrg[]
  orgID?: string
  allowedModelCount?: number
  failure?: string
  updatedAt: number
}

/** Cap on concurrent pending logins; the console expires codes anyway. */
const MAX_PENDING_LOGINS = 5
/** Cap on retained records; terminal ones evict oldest-first. */
const MAX_RECORDS = 32

function terminalOf(status: ZenLoginPhase): boolean {
  return status === 'done' || status === 'denied' || status === 'expired' || status === 'cancelled'
}

/**
 * Server-side Zen device-flow logins for UI surfaces. One instance per
 * plugin install; safe for concurrent logins and fiber disposal (pending
 * drivers abort on {@link dispose}).
 */
export class ZenLoginFlow {
  readonly #options: ZenLoginFlowOptions
  readonly #records = new Map<string, LoginRecord>()

  constructor(options: ZenLoginFlowOptions) {
    this.#options = options
  }

  /**
   * Start one login: issue the device code and poll for approval in the
   * background. Returns the operator-facing code and link immediately.
   */
  async start(): Promise<ZenLoginSnapshot> {
    this.prune()
    const pending = [...this.#records.values()].filter(record => !terminalOf(record.status)).length
    if (pending >= MAX_PENDING_LOGINS) {
      throw new LlmOAuthError('too many pending OpenCode logins; cancel one and try again')
    }
    const code = await requestDeviceCode(
      this.#options.consoleBase === undefined ? undefined : { consoleBase: this.#options.consoleBase },
    )
    const record: LoginRecord = {
      id: `login_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      code,
      abort: new AbortController(),
      status: 'pending',
      updatedAt: Date.now(),
    }
    this.#records.set(record.id, record)
    void this.drive(record)
    return this.snapshotOrThrow(record.id)
  }

  /** UI-safe view of one login; `undefined` for unknown ids. */
  snapshot(loginId: string): ZenLoginSnapshot | undefined {
    const record = this.#records.get(loginId)
    if (record === undefined) return undefined
    const view: ZenLoginSnapshot = { loginId: record.id, status: record.status }
    if (record.status === 'pending') {
      view.userCode = record.code.userCode
      view.verificationUri = record.code.verificationUri
      view.intervalSeconds = record.code.intervalSeconds
      view.expiresInSeconds = record.code.expiresInSeconds
    }
    if (record.orgs !== undefined) view.orgs = record.orgs.map(org => ({ ...org }))
    if (record.orgID !== undefined) view.orgID = record.orgID
    if (record.allowedModelCount !== undefined) view.allowedModelCount = record.allowedModelCount
    if (record.failure !== undefined) view.error = record.failure
    return view
  }

  /** {@link snapshot}, throwing if the just-created or just-updated record is somehow missing. */
  private snapshotOrThrow(loginId: string): ZenLoginSnapshot {
    const view = this.snapshot(loginId)
    if (view === undefined) throw new LlmOAuthError(`OpenCode login record ${loginId} vanished`)
    return view
  }

  /**
   * Record the billed workspace and persist the session. Only valid while
   * awaiting the pick; an omitted org keeps the session unbilled (manual
   * workspaces). Single and empty workspace lists never reach this state —
   * the driver completes them directly, mirroring the CLI.
   */
  async select(loginId: string, orgID?: string): Promise<ZenLoginSnapshot> {
    const record = this.#records.get(loginId)
    if (record === undefined) throw new LlmOAuthError(`unknown OpenCode login "${loginId}"`)
    if (record.status !== 'awaiting-org') {
      throw new LlmOAuthError(`OpenCode login "${loginId}" is ${record.status}; no workspace pick is open`)
    }
    if (orgID !== undefined && !(record.orgs ?? []).some(org => org.id === orgID)) {
      throw new LlmOAuthError(`workspace "${orgID}" is not offered by this login`)
    }
    await this.complete(record, orgID)
    return this.snapshotOrThrow(record.id)
  }

  /**
   * Abort one login. Unknown ids and terminal logins are no-ops returning
   * the current view (`undefined` only for unknown ids).
   */
  cancel(loginId: string): ZenLoginSnapshot | undefined {
    const record = this.#records.get(loginId)
    if (record === undefined) return undefined
    if (!terminalOf(record.status)) {
      record.abort.abort()
      record.status = 'cancelled'
      record.updatedAt = Date.now()
    }
    return this.snapshot(loginId)
  }

  /** Abort every pending login; fiber teardown calls this. */
  dispose(): void {
    for (const record of this.#records.values()) {
      if (!terminalOf(record.status)) {
        record.abort.abort()
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

  private async drive(record: LoginRecord): Promise<void> {
    try {
      const signal = record.abort.signal
      const base = this.#options.consoleBase === undefined
        ? undefined
        : { consoleBase: this.#options.consoleBase }
      const tokens = await pollDeviceToken(record.code, { signal, ...base })
      const orgs = await fetchOrgs(tokens.access, { signal, ...base })
      record.tokens = tokens
      if (orgs.length === 0) {
        await this.complete(record, undefined)
      } else if (orgs.length === 1) {
        record.orgs = [...orgs]
        const [only] = orgs
        await this.complete(record, only?.id)
      } else {
        record.orgs = [...orgs]
        record.status = 'awaiting-org'
      }
    } catch (error: unknown) {
      if (record.abort.signal.aborted) {
        if (!terminalOf(record.status)) record.status = 'cancelled'
      } else if (error instanceof Error && /expired/i.test(error.message)) {
        record.status = 'expired'
        record.failure = error.message
      } else {
        record.status = 'denied'
        record.failure = error instanceof Error ? error.message : String(error)
      }
    } finally {
      record.updatedAt = Date.now()
    }
  }

  private async complete(record: LoginRecord, orgID: string | undefined): Promise<void> {
    if (record.tokens === undefined) throw new LlmOAuthError('cannot complete an unapproved OpenCode login')
    let allowed: string[] | undefined
    if (orgID !== undefined) {
      try {
        allowed = await fetchAllowedModels(record.tokens.access, orgID,
          this.#options.consoleBase === undefined ? undefined : { consoleBase: this.#options.consoleBase })
      } catch {
        allowed = undefined
      }
    }
    await this.#options.store(this.#options.oauthRefOf(), JSON.stringify({
      ...record.tokens,
      ...(orgID === undefined ? {} : { orgID }),
      ...(allowed === undefined ? {} : { allowedModels: allowed }),
    }))
    if (orgID !== undefined) record.orgID = orgID
    if (allowed !== undefined) record.allowedModelCount = allowed.length
    record.status = 'done'
    record.updatedAt = Date.now()
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
