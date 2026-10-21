import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Queue records are append-only and service-owned; this companion reserves their invariant owner. */
export const name = 'agent-queue-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign((_ctx: Context) => undefined, { inject: ['agentQueue'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-agent-queue', install))
