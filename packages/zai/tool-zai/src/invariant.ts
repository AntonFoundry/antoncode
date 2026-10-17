/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-zai`.
 * @module @deepseek-ai/dsh-tool-zai/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-zai'

/** Cordis companion plugin name. */
export const name = 'tool-zai-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: native tools register directly on `ctx.tools`, so
 * there is no bridge generation to snapshot — registration state is the
 * registry's own.
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
