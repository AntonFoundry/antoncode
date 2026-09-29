/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-flowbuilder`.
 * @module @deepseek-ai/dsh-client-ui-flowbuilder/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-flowbuilder'

/** Cordis companion plugin name. */
export const name = 'ui-flowbuilder-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this browser plugin owns no independent event stream
 * or mutable data — every write goes through the flow.* wire domain, whose
 * server-side owner (dsh-flowbuilder-service) runs the companion that checks
 * the run/change event relations, and the canvas is a pure projection of
 * flow.* reads.
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
