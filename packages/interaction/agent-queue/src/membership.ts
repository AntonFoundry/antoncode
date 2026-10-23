/**
 * Shared queue authorization: exact live Agent identity plus header-derived
 * workspace membership, including subagent lineage. Both the workspace-scoped
 * v1 queue and the cross-workspace direct mailbox resolve a caller's workspace
 * through this one helper so a single rule governs forgery rejection.
 * @module @deepseek-ai/dsh-agent-queue/src/membership
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'

/** Collects the first membership rejection reason for the caller-facing error. */
export interface MembershipFailure { reason?: string }

/**
 * Build the rejection for an object that is not the exact live Agent it claims to be.
 * @returns the caller-facing forgery error.
 */
export const forgedCallerError = (): Error =>
  new Error('queue caller must be the exact live agent (reason: exact_live_agent_required)')

/**
 * Resolve the workspace a live Agent legitimately belongs to.
 *
 * A root session must be a filtered member of the workspace that owns its
 * immutable header working directory. A subagent inherits its root's
 * membership only while every ancestor is live, carries `origin: 'subagent'`,
 * and resolves to the same workspace record.
 * @param ctx - Context providing `agents` and `workspaceRegistry`.
 * @param agent - Candidate live Agent.
 * @param failure - Optional sink for the rejection reason.
 * @returns the authorized workspace, or `undefined` when unauthorized.
 */
export async function resolveAuthorizedWorkspace(
  ctx: Context,
  agent: Agent,
  failure?: MembershipFailure,
): Promise<Workspace | undefined> {
  const visited = new Set<SessionId>()
  let current: Agent | undefined = agent
  let expectedWorkspace: Workspace | undefined
  while (current) {
    const id = current.id
    const session = current.session
    if (visited.has(id) || ctx.agents.get(id) !== current || session.header.id !== id) {
      throw forgedCallerError()
    }
    visited.add(id)
    const cwd = session.header.cwd
    if (!cwd) {
      if (failure) failure.reason = 'missing_working_directory'
      return undefined
    }
    const workspace = await ctx.workspaceRegistry.resolveByPath(cwd)
    if (!workspace) {
      if (failure) failure.reason = 'unregistered_working_directory'
      return undefined
    }
    if (expectedWorkspace && (workspace.id !== expectedWorkspace.id || workspace.path !== expectedWorkspace.path)) {
      if (failure) failure.reason = 'workspace_lineage_mismatch'
      return undefined
    }
    if (session.header.parentSession === undefined) {
      if (!workspace.sessionIds.includes(id) && failure) failure.reason = 'root_not_registered_member'
      return workspace.sessionIds.includes(id) ? workspace : undefined
    }
    if (session.header.origin !== 'subagent') {
      if (failure) failure.reason = 'parent_without_subagent_origin'
      return undefined
    }
    expectedWorkspace = workspace
    const parent = ctx.agents.get(session.header.parentSession)
    if (!parent && failure) failure.reason = 'parent_not_live'
    current = parent
  }
  if (failure && !failure.reason) failure.reason = 'lineage_cycle_or_incomplete'
  return undefined
}

/**
 * Require that the caller is the exact live Agent and resolve its workspace.
 * @param ctx - Context providing `agents` and `workspaceRegistry`.
 * @param agent - Candidate live Agent.
 * @returns the authorized workspace.
 */
export async function authorizeWorkspaceMember(ctx: Context, agent: Agent): Promise<Workspace> {
  if (ctx.agents.get(agent.id) !== agent || agent.session.header.id !== agent.id) throw forgedCallerError()
  const failure: MembershipFailure = {}
  const workspace = await resolveAuthorizedWorkspace(ctx, agent, failure)
  if (!workspace) {
    throw new Error('queue caller is not a member of a registered workspace '
      + `(reason: ${failure.reason ?? 'not_a_registered_workspace_member'})`)
  }
  return workspace
}
