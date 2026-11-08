/** Ephemeral, addressed mail observations; registration never changes durable delivery. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { resolveAuthorizedWorkspace } from './membership.ts'

/** Advisory post-commit invalidation without message contents. */
export interface MailQueueNotice {
  readonly workspaceId: WorkspaceId
  readonly seq: number
}

/** Read the queue after installation and after each advisory invalidation. */
export type MailQueueListener = (notice: MailQueueNotice) => void | Promise<void>

interface Observation {
  readonly agent: Agent
  readonly session: Agent['session']
  readonly workspace: Workspace
  readonly listener: MailQueueListener
  readonly dispose: () => void
}

/** A queue instance owns these listeners independently of durable broadcast subscriptions. */
export class MailQueueObservers {
  private readonly entries = new Set<Observation>()
  private closed = false

  /** @param ctx - Queue owner used for exact live authorization and callback diagnostics. */
  constructor(private readonly ctx: Context) {}

  /**
   * Install an already-authorized observation at the queue's serialized operation point.
   * @param agent - Captured exact live recipient.
   * @param workspace - Captured authorized address.
   * @param listener - Advisory callback; failures cannot reject committed writes.
   * @param signal - Optional lifetime; omission requires explicit disposal.
   * @returns Idempotent listener cleanup, without durable effects.
   */
  add(agent: Agent, workspace: Workspace, listener: MailQueueListener, signal?: AbortSignal): () => void {
    signal?.throwIfAborted()
    if (this.closed) throw new Error('mail observation owner is disposed')
    const entry: Observation = { agent, session: agent.session, workspace, listener, dispose: () => {
      this.entries.delete(entry)
      signal?.removeEventListener('abort', entry.dispose)
    } }
    this.entries.add(entry)
    signal?.addEventListener('abort', entry.dispose, { once: true })
    return entry.dispose
  }

  /**
   * Notify only this committed address after rechecking the captured live authority.
   * @param workspaceId - Address workspace, never another workspace's activity.
   * @param sessionId - Addressed recipient or cursor owner.
   * @param seq - Committed send or acknowledgement sequence.
   * @returns After callback invocation; asynchronous callbacks run independently of queue writes.
   */
  async notify(workspaceId: WorkspaceId, sessionId: SessionId, seq: number): Promise<void> {
    for (const entry of this.entries) {
      if (entry.agent.id !== sessionId || entry.workspace.id !== workspaceId) continue
      try {
        const current = await resolveAuthorizedWorkspace(this.ctx, entry.agent)
        if (!current || entry.agent.session !== entry.session || current.id !== workspaceId || current.path !== entry.workspace.path) {
          entry.dispose()
          continue
        }
        if (this.entries.has(entry)) {
          const result = entry.listener({ workspaceId, seq })
          void Promise.resolve(result).catch((error) => { this.report(error) })
        }
      } catch (error) {
        this.report(error)
      }
    }
  }

  private report(error: unknown): void {
    this.ctx.logger.warn('Agent mail observation failed; committed mail remains available through a fresh read', error)
  }

  /** Close registration permanently and remove every observer when the owning queue unloads. */
  dispose(): void {
    this.closed = true
    for (const entry of this.entries) entry.dispose()
  }
}
