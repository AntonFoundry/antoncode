/** Resource-scoped Mail observation over the Remote generation supervisor. */
import type { ClientRemote, RemoteFailure, RemoteResult, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { AgentMailGateway, AgentMailSnapshot } from './gateway.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { agentmail: AgentMailSnapshot }
}

/** @param sessionId - addressed Session. @returns canonical Mail resource address. */
export function agentMailResourceAddress(sessionId: string): string {
  return `dsh-resource://agentmail/session/${encodeURIComponent(sessionId)}`
}

function sessionOf(address: string): string {
  const prefix = 'dsh-resource://agentmail/session/'
  const sessionId = address.startsWith(prefix) ? decodeURIComponent(address.slice(prefix.length)) : ''
  if (sessionId === '' || agentMailResourceAddress(sessionId) !== address) throw new Error('Invalid Agent Mail resource address')
  return sessionId
}

/** Recognize only the Remote supervisor's declared error marker, never arbitrary thrown messages. */
function remoteFailure(error: unknown): RemoteFailure | undefined {
  if (typeof error !== 'object' || error === null || !('isDSHRemoteError' in error)
    || error.isDSHRemoteError !== true || !('code' in error) || typeof error.code !== 'string'
    || !('message' in error) || typeof error.message !== 'string' || !('details' in error)) return undefined
  // Remote Gateway reconstructed this marker; its code and details retain their declared wire identity.
  return error as RemoteFailure
}

/** One resource's operation state; the gateway remains the only mailbox-data owner. */
class MailObservation {
  private readonly source
  private readonly stream
  private changed = true
  private failure: RemoteFailure | undefined
  /** A terminal watch failure persists while explicit queries can still update the mailbox. */
  private watchFailure: RemoteFailure | undefined
  private defect: Error | undefined
  private wake = Promise.withResolvers<void>()
  private dirty = false
  private generationSignal: AbortSignal | undefined
  private refreshing: Promise<void> | undefined

  constructor(
    private readonly gateway: AgentMailGateway,
    remote: Pick<ClientRemote, '$stream' | 'agentMail'>,
    private readonly sessionId: string,
    private readonly signal: AbortSignal,
  ) {
    this.source = gateway.source(sessionId)
    this.stream = remote.$stream({
      name: `Agent Mail of ${sessionId}`,
      open: lifetime => remote.agentMail.watch(sessionId as SessionId, lifetime),
      ended: () => new Error(`Agent Mail watch of ${sessionId} ended`),
    })
  }

  private notify(): void { this.changed = true; this.wake.resolve() }

  private async report(error: unknown, signal: AbortSignal, terminal = false): Promise<void> {
    if (signal.aborted) return
    const failure = remoteFailure(error)
    if (failure === undefined) {
      this.defect = error instanceof Error ? error : new Error('Agent Mail observation failed', { cause: error })
    } else {
      if (['agent-mail/owner-required', 'agent-mail/address-changed', 'remote-access/denied'].includes(failure.code)) {
        await this.gateway.revoke(this.sessionId)
      }
      if (terminal) this.watchFailure = failure
      else this.failure = failure
    }
    this.notify()
  }

  private refresh(): void {
    this.dirty = true
    if (this.refreshing !== undefined) return
    this.refreshing = this.readChanges().finally(() => { this.refreshing = undefined; this.wake.resolve() })
  }

  private async readChanges(): Promise<void> {
    while (this.dirty && !this.signal.aborted) {
      this.dirty = false
      const generation = this.generationSignal
      if (generation === undefined || generation.aborted) continue
      const signal = AbortSignal.any([this.signal, generation])
      try {
        if (this.source.getSnapshot().authorization.state === 'authorized') await this.gateway.refresh(this.sessionId, signal)
        else await this.gateway.authorize(this.sessionId, signal)
      } catch (error) { await this.report(error, signal) }
      if (this.defect !== undefined) return
    }
  }

  private async pump(): Promise<void> {
    try {
      for await (const item of this.stream) {
        if (this.signal.aborted) return
        item.accept()
        this.generationSignal = item.signal
        this.refresh()
      }
    } catch (error) { await this.report(error, this.signal, true) }
    finally { this.notify() }
  }

  async *frames(): AsyncIterable<RemoteResult<AgentMailSnapshot>> {
    const unsubscribe = this.source.subscribe(() => { this.notify() })
    const abort = (): void => { void this.stream.dispose(); this.wake.resolve() }
    this.signal.addEventListener('abort', abort, { once: true })
    const pumping = this.pump()
    try {
      while (!this.signal.aborted) {
        if (this.defect !== undefined) throw this.defect
        if (this.changed) {
          this.changed = false
          const value = this.source.getSnapshot()
          yield { ok: true, value }
          const error = this.watchFailure ?? this.failure
          if (error !== undefined) {
            this.failure = undefined
            const latest = this.source.getSnapshot()
            if (latest !== value) yield { ok: true, value: latest }
            this.changed = false
            yield { ok: false, error }
          }
        }
        const next = this.wake
        await next.promise
        if (this.wake === next) this.wake = Promise.withResolvers<void>()
      }
    } finally {
      this.signal.removeEventListener('abort', abort)
      unsubscribe()
      await this.stream.dispose()
      await pumping
      await this.refreshing
    }
  }
}

/**
 * Bind one resource lifetime to its read-only Host watch and gateway-owned aggregate.
 * @param gateway - sole mailbox snapshot and command owner.
 * @param remote - generated Mail methods and the shared reconnect supervisor.
 * @returns provider; the framework owns opening and releasing each address.
 */
export function createAgentMailResourceProvider(
  gateway: AgentMailGateway,
  remote: Pick<ClientRemote, '$stream' | 'agentMail'>,
): ResourceProvider<'agentmail'> {
  return {
    protocol: 'agentmail',
    async *open(address, { signal }) {
      const sessionId = sessionOf(address)
      if (!signal.aborted) yield* new MailObservation(gateway, remote, sessionId, signal).frames()
    },
  }
}
