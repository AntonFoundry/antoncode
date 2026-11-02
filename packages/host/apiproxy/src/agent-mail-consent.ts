import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mailConsentBinding, type MailConsentAction } from './native-consent-binding.ts'
import { NativeConsentVerifier } from './native-consent-code.ts'

/** One native pairing grants only these named queue operations, for one exact live Agent. */
export const MAIL_OPERATIONS = [
  'address', 'local-read', 'local-send', 'local-ack', 'direct-read', 'direct-send', 'direct-ack',
] as const
export type MailOperation = typeof MAIL_OPERATIONS[number]

export interface MailScope {
  readonly agent: Agent
  readonly origin: string
  readonly workspaceId: string
  readonly operations: readonly MailOperation[]
}

interface Pending {
  scope: MailScope
  expiresAt: number
}
interface Grant {
  scope: MailScope
  expiresAt: number
}

/**
 * Process-local pairing ledger. Neither the native seed nor the derived code
 * is exposed through this API. Exact object identity prevents a resumed Agent
 * reusing a durable sessionId to inherit an earlier incarnation's grant.
 */
export class AgentMailConsent {
  private readonly verifier: NativeConsentVerifier
  private readonly pending = new Map<string, Pending>()
  private readonly grants = new Map<string, Grant>()

  constructor(key: Uint8Array | undefined, private readonly now = Date.now) {
    this.verifier = new NativeConsentVerifier(key, now)
  }

  /** Validate a caller's operation set before it can back a grant. */
  private validOperations(operations: readonly MailOperation[]): boolean {
    return operations.length > 0 && operations.length <= MAIL_OPERATIONS.length
      && new Set(operations).size === operations.length
      && operations.every(operation => MAIL_OPERATIONS.includes(operation))
  }

  /**
   * Mint a grant for the loopback harness UI without a native code. The HTTP
   * carrier already proved the request reached the Host through the bridge for
   * the accepted local origin, so the native display ceremony adds no proof
   * for this same-machine UI. The grant keeps the same Agent, origin,
   * workspace, operation, and 30-minute expiry scope as a redeemed one.
   * @param scope - the exact live Agent, origin, workspace, and operations.
   * @returns the bearer grant, or undefined for an invalid operation set.
   */
  grantLocal(scope: MailScope): string | undefined {
    if (!this.validOperations(scope.operations)) return undefined
    this.prune()
    const token = randomUUID()
    this.grants.set(token, {
      scope: { ...scope, operations: [...scope.operations] },
      expiresAt: this.now() + 30 * 60_000,
    })
    return token
  }

  begin(scope: MailScope): { requestId: string; binding: string; expiresAt: number } | undefined {
    if (!this.validOperations(scope.operations)) return undefined
    this.prune()
    if (this.pending.size >= 16) return undefined
    const requestId = randomUUID()
    const expiresAt = this.now() + 90_000
    const binding = mailConsentBinding({
      sessionId: scope.agent.id, generation: requestId, origin: scope.origin,
      workspaceId: scope.workspaceId, operation: 'local-read',
      recipients: [...scope.operations].sort(), body: '',
    } satisfies MailConsentAction)
    if (!this.verifier.issue({ requestId, binding, expiresAt })) return undefined
    this.pending.set(requestId, { scope: { ...scope, operations: [...scope.operations] }, expiresAt })
    return { requestId, binding, expiresAt }
  }

  redeem(requestId: string, code: string, agent: Agent, origin: string, workspaceId: string): string | undefined {
    const entry = this.pending.get(requestId)
    if (!entry || entry.expiresAt <= this.now()) { this.revokePending(requestId); return undefined }
    if (entry.scope.agent !== agent || entry.scope.origin !== origin || entry.scope.workspaceId !== workspaceId) return undefined
    if (!this.verifier.verify(requestId, code)) return undefined
    this.pending.delete(requestId)
    const token = randomUUID()
    this.grants.set(token, { scope: entry.scope, expiresAt: this.now() + 30 * 60_000 })
    return token
  }

  allows(token: string, agent: Agent, origin: string, workspaceId: string, operation: MailOperation): boolean {
    const entry = this.grants.get(token)
    if (!entry) return false
    if (entry.expiresAt <= this.now() || entry.scope.agent !== agent
      || entry.scope.origin !== origin || entry.scope.workspaceId !== workspaceId) {
      this.grants.delete(token)
      return false
    }
    return entry.scope.operations.includes(operation)
  }

  revokeToken(token: string): void { this.grants.delete(token) }
  revokeAgent(agent: Agent): void {
    for (const [id, pending] of this.pending) if (pending.scope.agent === agent) this.revokePending(id)
    for (const [id, grant] of this.grants) if (grant.scope.agent === agent) this.grants.delete(id)
  }
  dispose(): void { this.verifier.revokeAll(); this.pending.clear(); this.grants.clear() }

  private revokePending(id: string): void { this.verifier.revoke(id); this.pending.delete(id) }
  private prune(): void {
    for (const [id, entry] of this.pending) if (entry.expiresAt <= this.now()) this.revokePending(id)
    for (const [id, entry] of this.grants) if (entry.expiresAt <= this.now()) this.grants.delete(id)
  }
}
