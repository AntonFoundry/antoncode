/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-file-image`.
 * @module @deepseek-ai/dsh-client-ui-file-image/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-file-image'

/** Cordis companion plugin name. */
export const name = 'client-ui-file-image-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package's single contribution is one keyed slot
 * registration, an effect owned and observed by the slot registry (the
 * browser-plugin spec proves install and fiber-teardown removal directly).
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
