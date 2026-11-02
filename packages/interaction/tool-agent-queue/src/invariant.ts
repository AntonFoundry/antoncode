/** Package-owned invariant companion for the stateless agent queue tool adapter. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'tool-agent-queue-invariant'
export const inject = ['invariants']
/** No runtime invariant: this adapter owns no queue state; service invariants govern durable messages and cursors. */
const install: InvariantInstaller = () => {}

/** Queue durability and authorization invariants belong to the host service. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-tool-agent-queue', install))
/* jscpd:ignore-end */
