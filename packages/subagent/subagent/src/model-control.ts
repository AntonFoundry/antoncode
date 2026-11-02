/**
 * Live-child model reassignment shared by `ctx.subagents` control surfaces.
 *
 * A reassignment installs the Agent-scoped model selection the child's requests
 * already route through, so it reaches the next model request — including the
 * retry of a step whose current route is exhausted — and every later request
 * until the Agent is disposed. The override is process-local: a cold resume
 * composes the descriptor's creation route again.
 *
 * @module @deepseek-ai/dsh-subagent/model-control
 */

import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentRegistry, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from './error.ts'
import type { SubagentAncestorAuthority } from './continuation.ts'

/**
 * Replace one live child's model route for its next model request.
 *
 * The first reassignment installs the Agent-scoped selection listeners; later
 * ones only advance the stored selection.
 * @param overrides - caller-owned override store, keyed by the exact live Agent.
 * @param agents - the live Agent registry the target is resolved from.
 * @param targetSessionId - durable id of the live child whose route changes.
 * @param selection - complete provider, model, and optional reasoning effort.
 * @param authority - the exact live ancestor Agent.
 * @throws {SubagentError} `NOT_LIVE` when no Agent is published under the id.
 * @throws {SubagentError} `UNAUTHORIZED` when the authority does not own the
 *   target: a stale or self-targeting caller, or a caller outside its live
 *   lineage.
 */
export function selectChildModel(
  overrides: WeakMap<Agent, ModelSelectionRef>,
  agents: AgentRegistry,
  targetSessionId: SessionId,
  selection: ModelSelection,
  authority: SubagentAncestorAuthority,
): void {
  const target = agents.get(targetSessionId)
  if (target === undefined) {
    throw new SubagentError(
      `subagent "${targetSessionId}" is not running; a model switch applies only to a live child`,
      'NOT_LIVE',
    )
  }
  applyLiveSelection(overrides, agents, target, selection, authority)
}

/**
 * Apply a selection to one already-resolved live target.
 *
 * Split out so the durable path below can reuse the exact same installation
 * once it has materialized a child, instead of duplicating the listener wiring.
 * @param overrides - caller-owned override store, keyed by the exact live Agent.
 * @param agents - the live Agent registry.
 * @param target - the exact live child whose route changes.
 * @param selection - complete provider, model, and optional reasoning effort.
 * @param authority - the exact live ancestor Agent.
 */
export function applyLiveSelection(
  overrides: WeakMap<Agent, ModelSelectionRef>,
  agents: AgentRegistry,
  target: Agent,
  selection: ModelSelection,
  authority: SubagentAncestorAuthority,
): void {
  assertAncestor(agents, target, authority)
  let ref = overrides.get(target)
  if (ref === undefined) {
    ref = { current: selection, assembled: selection }
    // The Agent-scoped listeners retire with the target; a replacement Agent
    // under the same durable id is a different key and starts from its own route.
    installModelSelection(target.ctx, ref)
    overrides.set(target, ref)
    return
  }
  ref.current = selection
  // A step that opened before this switch keeps its assembly snapshot, so
  // advancing the snapshot is what lets the failing attempt's retry use the
  // replacement route instead of retrying the exhausted one until cancellation.
  ref.assembled = selection
}

/**
 * Require the caller to be an exact live ancestor of the target.
 * @param agents - the live Agent registry.
 * @param target - the exact live target to authorize against.
 * @param authority - the presented ancestor Agent.
 * @throws {SubagentError} `UNAUTHORIZED` with the failing relationship.
 */
function assertAncestor(
  agents: AgentRegistry,
  target: Agent,
  authority: SubagentAncestorAuthority,
): void {
  const caller = authority.agent
  // A stale caller is rejected even when the target is live, so a replaced
  // same-id Agent can never control its namesake through this registry.
  if (agents.get(caller.id) !== caller) {
    throw new SubagentError(
      `changing the model of "${target.id}" requires the exact live ancestor agent`,
      'UNAUTHORIZED',
    )
  }
  if (caller.id === target.id) {
    throw new SubagentError(
      `agent "${caller.id}" cannot change its own child model`,
      'UNAUTHORIZED',
    )
  }
  const visited = new Set<SessionId>([target.id])
  let current: Agent | undefined = target
  while (current !== undefined) {
    const parentId = current.session.header.parentSession
    if (parentId === undefined) break
    if (parentId === caller.id) return
    /* v8 ignore next 3 -- the durable parent chain is acyclic by construction;
     * the visited set only keeps a corrupt persisted header from looping. */
    if (visited.has(parentId)) break
    visited.add(parentId)
    current = agents.get(parentId)
  }
  throw new SubagentError(
    `subagent "${target.id}" is not a live descendant of agent "${caller.id}"`,
    'UNAUTHORIZED',
  )
}
