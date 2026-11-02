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

  /** @returns current sidecar state. */
  @Remote
  status(): LangflowStatus { return this.ctx.langflow.status() }

  /** @returns sidecar state after startup. */
  @Remote
  start(): Promise<LangflowStatus> { return this.ctx.langflow.start() }

  /** @returns sidecar state after shutdown. */
  @Remote
  async stop(): Promise<LangflowStatus> {
    await this.ctx.langflow.stop()
    return this.ctx.langflow.status()
  }
}
