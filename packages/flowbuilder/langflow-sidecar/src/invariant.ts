/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-langflow-sidecar`.
 * @module @deepseek-ai/dsh-langflow-sidecar/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-langflow-sidecar'

/** Cordis companion plugin name. */
export const name = 'langflow-sidecar-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the sidecar owns one child process and a private
 * state machine with no event stream or shared mutable medium to cross-check.
 * State transitions and teardown are covered by the stubbed-runtime tests.
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
