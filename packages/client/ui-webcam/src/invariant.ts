/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-webcam`.
 * @module @deepseek-ai/dsh-client-ui-webcam/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-webcam'

/** Cordis companion plugin name. */
export const name = 'client-ui-webcam-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a pure slot occupant — the view derives everything
 * from the injected camera-engine faces and the shared settings store; it
 * emits no cordis events and owns no cross-plugin mutable state. The
 * camera↔view lifecycle (refcounted capture on mount, release on unmount,
 * lazy model load on the first effect change) is asserted directly by this
 * package's component and engine specs.
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
