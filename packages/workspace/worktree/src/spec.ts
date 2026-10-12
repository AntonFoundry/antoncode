/**
 * The worktree domain declaration: record/pref schemas and the `defineDomain`
 * spec the registry opens. The zod schemas are the durable-boundary validator
 * and the direct source of the RPC wire projection.
 * @module @deepseek-ai/dsh-worktree/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorktreeId } from './types.ts'

/** Worktree id schema at the durable boundary; branding has no runtime representation. */
const worktreeId = z.string().transform(value => value as WorktreeId)

/**
 * Durable shape of one worktree record: the git worktree directory a create
 * materialized, anchored to the repository it branched from. `id` repeats the
 * table key so records are self-contained for projection; `repoPath` and
 * `path` are realpath-normal canonical directory paths stamped at create and
 * never rewritten; `workspaceId` records the workspace registered over
 * `path`, when that registration succeeded; timestamps are ISO-8601 strings.
 */
export const worktreeRecord = z.object({
  id: worktreeId,
  repoPath: z.string(),
  path: z.string(),
  branch: z.string(),
  base: z.string(),
  workspaceId: z.string().optional(),
  /** Display name claimed from the first titled session inside the worktree. */
  alias: z.string().optional(),
  /** Session whose titles own {@link alias}; other sessions never rename it. */
  aliasSessionId: z.string().optional(),
  createdAt: z.string(),
})

/** One stored worktree record, inferred from {@link worktreeRecord}. */
export type WorktreeRecord = z.infer<typeof worktreeRecord>

/**
 * Durable per-repo default workspace mode for new sessions: sessions open in
 * the repository checkout (`checkout`), in a fresh worktree per session
 * (`new`), or in the named existing worktree (`reuse`).
 */
export const worktreeModePref = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('checkout'), base: z.string().optional() }),
  z.object({ mode: z.literal('new'), base: z.string().optional() }),
  z.object({ mode: z.literal('reuse'), worktreeId, base: z.string().optional() }),
])

/** Durable mode preference inferred from {@link worktreeModePref}. */
export type WorktreeModePref = z.infer<typeof worktreeModePref>

/**
 * Durable registry state. `worktreeIds` is the authoritative display order
 * (newest first); `prefs` keys the per-repository default workspace mode by
 * canonical repository path. Defaulted so records written before a field
 * existed parse unchanged.
 */
export const worktreeDomainState = z.object({
  initialized: z.boolean().default(false),
  worktreeIds: z.array(worktreeId).default([]),
  prefs: z.record(z.string(), worktreeModePref).default({}),
})

/** Durable registry state inferred from {@link worktreeDomainState}. */
export type WorktreeDomainState = z.infer<typeof worktreeDomainState>

/**
 * The worktree domain spec: one `worktrees` table keyed by {@link WorktreeId}
 * plus the order/preference singleton. The registry opens this through
 * `ctx.storageDomain`; the spec object is the single source of the domain's
 * identity, version, and schemas.
 */
export const worktreeDomainSpec = defineDomain({
  name: 'worktree',
  version: 1,
  global: {
    schema: worktreeDomainState,
    initial: { initialized: false, worktreeIds: [], prefs: {} },
  },
  tables: { worktrees: domainTable<WorktreeId, WorktreeRecord>(worktreeRecord) },
})
