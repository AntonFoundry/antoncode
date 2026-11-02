/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-flowbuilder-domain`.
 * @module @deepseek-ai/dsh-flowbuilder-domain/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-flowbuilder-domain'

/** Cordis companion plugin name. */
export const name = 'flowbuilder-domain-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns types, zod schemas, a pure DAG
 * validator, and a domain spec — no event stream and no mutable data of its
 * own. Graph well-formedness is checked at every save call site
 * (`validateFlowStructure`), and the service package's companion owns the
 * lifecycle event relations.
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
