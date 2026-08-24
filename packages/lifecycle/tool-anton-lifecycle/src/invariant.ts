/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-anton-lifecycle`.
 * @module @deepseek-ai/dsh-tool-anton-lifecycle/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-anton-lifecycle'

/** Cordis companion plugin name. */
export const name = 'tool-anton-lifecycle-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin owns no durable event relation — every tool is an
 * out-of-process HTTP round-trip to the Anton supervisor, whose results are logged by the
 * session machinery like any tool result. The round-trip contracts are proven by package tests.
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
