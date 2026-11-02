/**
 * Direct-child and recursive descendant discovery from parent-owned catalogs.
 * Each catalog read releases its Session observation before the next branch.
 * Descendant child rows also carry the child's own cumulative provider usage
 * (`tokenUsage`, when the token-meter unit is registered and the child has
 * reported usage) and its latest epoch outcome (`subagentOutcome`), both read
 * from the same observation as the child's catalog.
 * @module @deepseek-ai/dsh-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentListEntry } from './control-types.ts'
import { SubagentError } from './error.ts'
import type { SubagentCatalogEntry, SubagentOutcomeProjection } from './projection-types.ts'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

export type { SubagentListEntry } from './control-types.ts'

/** Durable facts a descendant child row reads from the child's own Session. */
export interface SubagentChildFacts {
  /**
   * Cumulative provider-reported usage folded from the child's own log
   * (`tokenUsage` projection, including the derived `cacheHitRate`); absent
   * until the child's first usage report and when the token-meter unit is not
   * registered in this deployment's projection registry.
   */
  readonly usage?: TokenUsageProjection
  /**
   * How the child's most recent closed epoch ended, in `subagent/end`
   * stop-reason vocabulary (`completed`, `error`, `aborted`, `max-tokens`,
   * `refusal`), with the failure message for an `error` ending. Absent before
   * the first epoch closes. A master agent reads it to decide whether to
   * resume a failed child, switch its model, or give up.
   */
  readonly outcome?: SubagentOutcomeProjection
}

/** One catalog descendant with its direct parent and edge distance from the requested root. */
export type SubagentDescendantListEntry = (
  | (Extract<SubagentListEntry, { readonly kind: 'child' }> & SubagentChildFacts)
  | Exclude<SubagentListEntry, { readonly kind: 'child' }>
) & {
  /** Parent whose catalog contains this child. */
  readonly parentId: SessionId
  /** Edge distance from the requested root; direct children are `1`. */
  readonly depth: number
}

/** One observed Session's direct-child catalog and its own child facts. */
interface ObservedCatalog {
  readonly entries: SubagentCatalogEntry[]
  readonly facts: SubagentChildFacts
}

/**
 * Read one parent's durable catalog through a live-preferred Session observation.
 * @param ctx - context carrying the Session query service.
 * @param parentSessionId - parent whose direct children are requested.
 * @param signal - cancellation forwarded to the Session observation.
 * @returns direct-child rows in parent catalog event order.
 * @throws {@link SubagentError} when query or catalog projection is unavailable.
 */
export async function listChildren(
  ctx: Context,
  parentSessionId: SessionId,
  signal?: AbortSignal,
): Promise<SubagentCatalogEntry[]> {
  return (await observeCatalog(ctx, parentSessionId, signal)).entries
}

/**
 * Read one Session's durable catalog and its own usage and outcome facts
 * through one live-preferred Session observation.
 * @param ctx - context carrying the Session query service.
 * @param parentSessionId - Session whose direct children are requested.
 * @param signal - cancellation forwarded to the Session observation.
 * @returns direct-child rows in catalog event order and the Session's own facts.
 * @throws {@link SubagentError} when query or catalog projection is unavailable.
 */
async function observeCatalog(
  ctx: Context,
  parentSessionId: SessionId,
  signal?: AbortSignal,
): Promise<ObservedCatalog> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    throw new SubagentError(
      'listing subagents requires the sessionQuery service (load @deepseek-ai/dsh-session-query)',
      'SUBAGENT_CONTROL_QUERY_UNAVAILABLE',
    )
  }
  using parent = await query.observeSession(parentSessionId, {
    ...signal === undefined ? {} : { signal },
  })
  const values = parent.projections?.values
  const entries = values?.subagentCatalog
  if (entries === undefined) {
    throw new SubagentError(
      'listing subagents requires the registered subagentCatalog projection',
      'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE',
    )
  }
  const usage = servedUsage(values?.tokenUsage)
  const outcome = values?.subagentOutcome
  return {
    entries,
    facts: {
      ...usage === undefined ? {} : { usage },
      ...outcome === undefined || outcome === null ? {} : { outcome },
    },
  }
}

/** The served usage row, absent before the Session's first usage report. */
function servedUsage(value: TokenUsageProjection | null | undefined): TokenUsageProjection | undefined {
  if (value === undefined || value === null) return undefined
  return value.uncachedInputTokens === 0
    && value.outputTokens === 0
    && value.cacheReadTokens === 0
    && value.cacheWriteTokens === 0
    ? undefined
    : value
}

/**
 * Walk reachable parent catalogs in stable pre-order without loading Agents.
 * @see SubagentRuntime.listDescendants for failure and cancellation semantics.
 * @param ctx - context carrying the Session store and query service.
 * @param rootSessionId - parent whose catalog starts the traversal.
 * @param signal - cancellation checked around each catalog read.
 * @returns children and branch diagnostics with catalog parent and depth.
 */
export async function listDescendants(
  ctx: Context,
  rootSessionId: SessionId,
  signal?: AbortSignal,
): Promise<SubagentDescendantListEntry[]> {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) {
    throw new SubagentError(
      'listing subagents requires the session store (load @deepseek-ai/dsh-session)',
      'SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE',
    )
  }
  const readChildren = async (id: SessionId): Promise<ObservedCatalog> => {
    assertListingNotCancelled(signal)
    let children: ObservedCatalog
    try {
      children = await observeCatalog(ctx, id, signal)
    } catch (error) {
      assertListingNotCancelled(signal)
      throw error
    }
    assertListingNotCancelled(signal)
    return children
  }
  const stack = (await readChildren(rootSessionId)).entries
    .map(entry => ({ entry, parentId: rootSessionId, depth: 1 }))
    .reverse()
  const visited = new Set<SessionId>([rootSessionId])
  const result: SubagentDescendantListEntry[] = []
  for (let position = stack.pop(); position !== undefined; position = stack.pop()) {
    const { entry, parentId, depth } = position
    if (visited.has(entry.id)) continue
    visited.add(entry.id)
    let observed: ObservedCatalog
    try {
      observed = entry.mode === 'external' ? { entries: [], facts: {} } : await readChildren(entry.id)
    } catch (error) {
      if (error instanceof SubagentError) throw error
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      result.push({
        kind: 'diagnostic', id: entry.id, parentId, depth,
        reason: code === 'SESSION_QUERY_CORRUPT_SESSION' || code === 'SESSION_QUERY_SOURCE_CONFLICT'
          ? 'corrupt' : 'unavailable',
      })
      continue
    }
    if (entry.mode === 'unknown') {
      result.push({ kind: 'diagnostic', id: entry.id, parentId, depth, reason: 'unsupported' })
    } else {
      const { createdAt: _createdAt, ...identity } = entry
      result.push({
        ...identity, kind: 'child', parentId, depth,
        activity: sessions.get(entry.id) === undefined ? 'inactive' : 'running',
        hasChildren: observed.entries.length > 0,
        ...observed.facts,
      })
    }
    const children = observed.entries
    // Catalog event order defines siblings; the stack visits the first one next.
    for (const child of [...children].reverse()) {
      stack.push({ entry: child, parentId: entry.id, depth: depth + 1 })
    }
  }
  return result
}

/** Stop the complete traversal when its caller cancels. */
function assertListingNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SubagentError('subagent listing was cancelled', 'CANCELLED')
  }
}
