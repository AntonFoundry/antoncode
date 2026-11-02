import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  isWorkspaceActive, liveJobCounts, orderWorkspacesByActivity, WORKSPACE_ACTIVITY_WINDOW_MS,
} from '../src/client/workspace-activity.ts'
import { deriveGroups } from '../src/client/tree.ts'
import type { SessionRowState } from '../src/client/tree.ts'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { JobView } from '@deepseek-ai/dsh-api-job-controller/types'

type ActivityList = SessionListState & { jobsBySession: Record<SessionId, readonly JobView[]> }

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const HOUR = 3_600_000
const DAY = 24 * HOUR

const summary = (id: string, updatedAt: number, running = false): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, running, blank: false, updatedAt, retainedBy: {},
})
const list = (...items: SessionSummary[]): ActivityList => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  phase: 'ready', projectionsBySession: {}, jobsBySession: {},
})
const job = (status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed') =>
  ({ id: `bash-${status}`, kind: 'bash', label: 'task', status, startedAt: 0 }) as never
const withJobs = (base: ActivityList, bySession: Record<string, readonly JobView[]>): ActivityList => ({
  ...base, jobsBySession: bySession,
})
const workspace = (id: string, sessionIds: string[], title = id): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})

describe('orderWorkspacesByActivity', () => {
  it('floats a running-session workspace above inactive ones regardless of Host order', () => {
    const now = 10_000 * HOUR
    const sessions = list(summary('a', now - 10 * DAY), summary('b', now - 10 * DAY, true))
    const entries = orderWorkspacesByActivity(
      [workspace('w1', ['a']), workspace('w2', ['b'])], sessions, now,
    )
    expect(entries.map(entry => entry.workspace.workspaceId)).toEqual([wid('w2'), wid('w1')])
    expect(entries.map(entry => entry.active)).toEqual([true, false])
  })

  it('floats a workspace whose latest activity is 1h old', () => {
    const now = 10_000 * HOUR
    const sessions = list(summary('a', now - HOUR))
    const entries = orderWorkspacesByActivity([workspace('w1', ['a'])], sessions, now)
    expect(entries[0]!.active).toBe(true)
  })

  it('keeps a workspace with 10-day-old activity and nothing running in Host order', () => {
    const now = 10_000 * HOUR
    const sessions = list(summary('a', now - 10 * DAY), summary('b', now - 20 * DAY))
    const entries = orderWorkspacesByActivity(
      [workspace('w1', ['a']), workspace('w2', ['b'])], sessions, now,
    )
    expect(entries.map(entry => entry.workspace.workspaceId)).toEqual([wid('w1'), wid('w2')])
    expect(entries.map(entry => entry.active)).toEqual([false, false])
  })

  it('treats the window boundary as expired at exactly 7d', () => {
    const now = 10_000 * HOUR
    const sessions = list(summary('a', now - WORKSPACE_ACTIVITY_WINDOW_MS))
    expect(isWorkspaceActive(workspace('w1', ['a']), sessions, now)).toBe(false)
  })

  it('sorts the active group case-insensitively by display title', () => {
    const now = 10_000 * HOUR
    const running = summary('r', now, true)
    const sessions = list(running)
    const entries = orderWorkspacesByActivity(
      [workspace('w1', ['r'], 'beta'), workspace('w2', ['r'], 'Alpha'), workspace('w3', ['r'], 'gamma')],
      sessions, now,
    )
    expect(entries.map(entry => entry.workspace.title)).toEqual(['Alpha', 'beta', 'gamma'])
  })

  it('preserves Host order within the inactive group', () => {
    const stale = summary('s', 0)
    const sessions = list(stale)
    const entries = orderWorkspacesByActivity(
      [workspace('w3', ['s']), workspace('w1', []), workspace('w2', ['s'])], sessions, 10_000 * HOUR,
    )
    expect(entries.map(entry => entry.workspace.workspaceId)).toEqual([wid('w3'), wid('w1'), wid('w2')])
  })

  it('handles empty inputs', () => {
    expect(orderWorkspacesByActivity([], list(), 0)).toEqual([])
    expect(orderWorkspacesByActivity([workspace('w1', [])], list(), 0)).toEqual([
      { workspace: workspace('w1', []), active: false },
    ])
  })
  it('floats a workspace whose session owns a live background job even when idle and cold', () => {
    const now = 10_000 * HOUR
    const sessions = withJobs(list(summary('a', now - 3 * HOUR)), { a: [job('running')] })
    expect(isWorkspaceActive(workspace('w1', ['a']), sessions, now)).toBe(true)
    const entries = orderWorkspacesByActivity([workspace('w1', ['a'])], sessions, now)
    expect(entries[0]!.active).toBe(true)
  })

  it('ignores settled jobs for both the float and the counter', () => {
    const now = 10_000 * HOUR
    const sessions = withJobs(list(summary('a', now - 10 * DAY)), { a: [job('completed'), job('failed')] })
    expect(isWorkspaceActive(workspace('w1', ['a']), sessions, now)).toBe(false)
    expect(liveJobCounts(sessions.jobsBySession).size).toBe(0)
  })
})

describe('deriveGroups job activity', () => {
  const now = 10_000 * HOUR
  const base = list(summary('s1', now - 3 * HOUR))
  const withJob = withJobs(base, { s1: [job('running'), job('stopping')] })

  it('reports the live job count on the session node so its row animates', () => {
    const groups = deriveGroups(withJob, [workspace('w1', ['s1'])], { archivedSessionIds: [], pinnedSessionIds: [], archivedFilter: 'default' } as SessionRowState, new Map() as SessionStatusSnapshot, {
      expandedGroups: ['w1'],
    }, { stagedSessionIds: [], runningJobCounts: liveJobCounts(withJob.jobsBySession) })
    expect(groups[0]!.sessions[0]!.runningJobCount).toBe(2)
    expect(groups[0]!.sessions[0]!.running).toBe(false)
  })

  it('counts zero without jobs and never invents them from nothing', () => {
    const groups = deriveGroups(base, [workspace('w1', ['s1'])], { archivedSessionIds: [], pinnedSessionIds: [], archivedFilter: 'default' } as SessionRowState, new Map() as SessionStatusSnapshot, {
      expandedGroups: ['w1'],
    }, { stagedSessionIds: [], runningJobCounts: liveJobCounts(base.jobsBySession) })
    expect(groups[0]!.sessions[0]!.runningJobCount).toBe(0)
  })
})
