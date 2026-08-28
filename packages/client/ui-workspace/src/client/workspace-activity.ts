/**
 * Activity-aware display ordering for the Workspace browser's group list:
 * active Workspaces (a member Session running, or recent session activity)
 * float to the top alphabetically; inactive Workspaces keep the Host order
 * below. Pure view-layer derivation — the Host/persisted order is never
 * mutated.
 */
import type { SessionId, SessionListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * A Workspace with no running Session still counts as active while its latest
 * session activity (`updatedAt`: the later of creation and the latest
 * human-authored prompt) is younger than this window.
 */
export const WORKSPACE_ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000

/** One ordered Workspace plus the activity fact its row renders. */
export interface WorkspaceActivityEntry {
  workspace: WorkspaceView
  /** A member session is running, or its latest activity is inside the window. */
  active: boolean
}

/**
 * Activity predicate: any member session currently `running`, or the newest
 * member `updatedAt` less than {@link WORKSPACE_ACTIVITY_WINDOW_MS} old.
 * Sessions the account has not resolved yet contribute nothing.
 * @param workspace - workspace whose member sessions are inspected.
 * @param list - sessions list snapshot (summaries and the job registry mirror).
 * @param now - current epoch ms (injected for pure derivation).
 * @returns true when the workspace row should float to the active group.
 */
export function isWorkspaceActive(
  workspace: WorkspaceView,
  list: Pick<SessionListState, 'byId' | 'jobsBySession'>,
  now: number,
): boolean {
  for (const sessionId of workspace.sessionIds) {
    const session = list.byId[sessionId]
    if (session === undefined) continue
    if (session.running) return true
    if (now - session.updatedAt < WORKSPACE_ACTIVITY_WINDOW_MS) return true
    const jobs = list.jobsBySession[sessionId]
    if (jobs !== undefined && jobs.some(isLiveJob)) return true
  }
  return false
}

/**
 * A job the registry still holds open, mirroring the header jobs indicator's
 * live set: `running` and `stopping` both animate; settled states never do.
 */
export function isLiveJob(job: { status: string }): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/**
 * Live (running or stopping) background-job count per session id, consumed by
 * the session row's status slot — a session can be idle yet own live jobs, and
 * that work must still animate its row.
 * @param jobsBySession - the sessions list snapshot's job registry mirror.
 * @returns counts keyed by session id; sessions without live jobs are absent.
 */
export function liveJobCounts(jobsBySession: SessionListState['jobsBySession']): ReadonlyMap<SessionId, number> {
  const counts = new Map<SessionId, number>()
  for (const [sessionId, jobs] of Object.entries(jobsBySession)) {
    const count = jobs.filter(isLiveJob).length
    if (count > 0) counts.set(sessionId as SessionId, count)
  }
  return counts
}

/**
 * Order the browser's workspace groups: active workspaces first, sorted by
 * display title case-insensitively (title, then workspace id as the
 * deterministic tie-break); inactive workspaces follow in unchanged Host
 * order. Returns entries so the renderer can tint and dot the active rows
 * without recomputing the predicate.
 * @param workspaces - real workspaces in stable Host order.
 * @param list - sessions list snapshot.
 * @param now - current epoch ms (injected for pure derivation).
 * @returns entries in render order; the input array is not mutated.
 */
export function orderWorkspacesByActivity(
  workspaces: readonly WorkspaceView[],
  list: Pick<SessionListState, 'byId' | 'jobsBySession'>,
  now: number,
): WorkspaceActivityEntry[] {
  const entries = workspaces.map(workspace => ({
    workspace,
    active: isWorkspaceActive(workspace, list, now),
  }))
  const inactive = entries.filter(entry => !entry.active)
  const active = entries
    .filter(entry => entry.active)
    .sort((a, b) => {
      const byTitle = a.workspace.title.localeCompare(b.workspace.title, undefined, { sensitivity: 'base' })
      if (byTitle !== 0) return byTitle
      return a.workspace.workspaceId < b.workspace.workspaceId ? -1 : 1
    })
  return [...active, ...inactive]
}
