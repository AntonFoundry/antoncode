/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-flowbuilder`.
 * @module @deepseek-ai/dsh-tool-flowbuilder/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-flowbuilder'

/** Cordis companion plugin name. */
export const name = 'tool-flowbuilder-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this model-facing adapter owns no independent event
 * stream or mutable data — every write lands in `ctx.flowBuilder`, whose
 * companion owns the change-event payload checks, and tool-call transcripts
 * are owned by the session log.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
