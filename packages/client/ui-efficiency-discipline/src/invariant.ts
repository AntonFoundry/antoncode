/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-efficiency-discipline`.
 * @module @deepseek-ai/dsh-client-ui-efficiency-discipline/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-efficiency-discipline'

/** Cordis companion plugin name. */
export const name = 'client-ui-efficiency-discipline-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a single durable settings-section registration whose
 * schema is validated by the settings service and whose read path (tools
 * runtime per-assembly fallback) is exercised by the discipline settings
 * spec — the plugin owns no store and emits no cordis events.
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
