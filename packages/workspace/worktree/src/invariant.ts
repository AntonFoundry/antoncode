/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-worktree`.
 * @module @deepseek-ai/dsh-worktree/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { WorktreeId } from '@deepseek-ai/dsh-worktree'

const PACKAGE_NAME = '@deepseek-ai/dsh-worktree'

/** Cordis companion plugin name. */
export const name = 'worktree-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Owned relationship: the registry's record cache mirrors the worktree
 * domain's durable table. Every `domain/changed` for the `worktrees` table
 * must agree with `ctx.worktreeRegistry.get()` on both directions: a put
 * without a cached record proves a write path that bypassed the registry,
 * and a delete while the cache still serves the record proves the cache and
 * the table have diverged.
 */
const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: (message: string) => never) => {
    ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.domain !== 'worktree' || change.table !== 'worktrees') return
      if (change.operation === 'deleted') {
        if (ctx.worktreeRegistry.get(WorktreeId(change.key)) !== undefined) {
          fail(
            `worktree record '${change.key}' was deleted while the registry cache still `
            + 'serves it — the cache and the domain table have diverged',
          )
        }
        return
      }
      if (ctx.worktreeRegistry.get(WorktreeId(change.key)) === undefined) {
        fail(
          `worktree record '${change.key}' landed durably but the registry cache holds `
          + 'no record for it — some write path bypassed ctx.worktreeRegistry',
        )
      }
    })
  },
  { inject: ['worktreeRegistry'] },
)

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
