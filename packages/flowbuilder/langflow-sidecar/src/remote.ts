/** Host Remote methods for the local LangFlow sidecar. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { LangflowStatus } from './types.ts'

/** Browser-accessible sidecar lifecycle. */
export class LangflowRemote extends TypertRemoteService {
  static inject = ['typert', 'langflow']

  /** @param ctx - Host context with the sidecar service. */
  constructor(ctx: Context) {
    super(ctx, 'langflowRemote', { namespace: 'langflow' })
  }

  /**
   * Read the sidecar lifecycle snapshot without starting the child.
   * @returns Current sidecar state, with its URL or failure details when available.
   */
  @Remote
  status(): LangflowStatus { return this.ctx.langflow.status() }

  /**
   * Start the sidecar or join the service's existing startup attempt.
   * @returns Post-start state; readiness failures return error state, while setup failures may reject.
   */
  @Remote
  start(): Promise<LangflowStatus> { return this.ctx.langflow.start() }

  /**
   * Stop the sidecar and wait for its child process to exit before reading status.
   * @returns Sidecar state after shutdown completes; termination failures reject.
   */
  @Remote
  async stop(): Promise<LangflowStatus> {
    await this.ctx.langflow.stop()
    return this.ctx.langflow.status()
  }
}
