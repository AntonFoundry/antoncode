/**
 * bridge.ts: run derivation from an `orchestrator.board` snapshot — the live
 * `running` flag wins over recency, parent/child linking, active-only
 * filtering, the archive set, and orphan subagents.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionSummary as WireSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { deriveRuns, type BoardSnapshot } from '../src/client/bridge.ts'

const NOW = 1_000_000

const summary = (id: string, over: Partial<WireSummary> = {}): WireSummary => ({
  id: id as SessionId,
  displayTitle: id,
  retainedBy: {},
  updatedAt: NOW,
  running: false,
  blank: false,
  ...over,
})

const workspace = (workspaceId: string, sessionIds: string[]): WorkspaceView => ({
  workspaceId: workspaceId as WorkspaceView['workspaceId'],
  path: `/tmp/${workspaceId}`,
  title: workspaceId,
  sessionIds: sessionIds.map(s => s as SessionId),
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

const board = (over: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  items: [],
  archivedSessionIds: [],
  sessions: [],
  ...over,
})

describe('deriveRuns: plan folding', () => {
  const todos: readonly { content: string; status: 'completed' | 'in_progress' | 'pending'; children?: readonly { content: string; status: 'pending' }[] }[] = [
    { content: 'ship the board', status: 'completed' },
    { content: 'polish cards', status: 'in_progress', children: [{ content: 'plan rows', status: 'pending' }] },
  ]

  it('flattens the todos projection into depth-first plan rows', () => {
    const runs = deriveRuns(board({
      items: [workspace('w', ['root'])],
      sessions: [summary('root', { running: true, projectionValues: { todos } as NonNullable<WireSummary['projectionValues']> })],
    }))
    expect(runs).toHaveLength(1)
    expect(runs[0]?.plan).toEqual([
      { content: 'ship the board', status: 'completed' },
      { content: 'polish cards', status: 'in_progress' },
      { content: 'plan rows', status: 'pending' },
    ])
  })

  it('plans nothing without a todos projection', () => {
    const runs = deriveRuns(board({
      items: [workspace('w', ['bare'])],
      sessions: [summary('bare'), summary('nulled', { projectionValues: { todos: null } as NonNullable<WireSummary['projectionValues']> })],
    }))
    expect(runs[0]?.plan).toBeUndefined()
    expect(runs[1]?.plan).toBeUndefined()
  })
})

describe('deriveRuns: state', () => {
  it('the live running flag wins over recency', () => {
    const runs = deriveRuns(board({
      items: [workspace('w', ['live'])],
      sessions: [summary('live', { running: true, updatedAt: NOW - 10 * 24 * 60 * 60 * 1000 })],
    }), { now: NOW })
    expect(runs[0]?.state).toBe('running')
  })

  it('a non-running session updated within 24h reads queued, older reads done', () => {
    const runs = deriveRuns(board({
      items: [workspace('w', ['fresh', 'stale'])],
      sessions: [
        summary('fresh', { updatedAt: NOW - 1000 }),
        summary('stale', { updatedAt: NOW - 25 * 60 * 60 * 1000 }),
      ],
    }), { now: NOW, activeOnly: false })
    expect(runs.map(r => [r.id, r.state])).toEqual([['fresh', 'queued'], ['stale', 'done']])
  })
})

describe('deriveRuns: linking and filtering', () => {
  it('subagent children attach under their parentSessionId', () => {
    const runs = deriveRuns(board({
      items: [workspace('w', ['root'])],
      sessions: [
        summary('root', { running: true }),
        summary('kid', { origin: 'subagent', parentId: 'root' as SessionId, running: true }),
      ],
    }), { now: NOW })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.children.map(c => c.id)).toEqual(['kid'])
    expect(runs[0]?.children[0]?.parentId).toBe('root')
  })

  it('archived sessions never render, alone or as children', () => {
    const runs = deriveRuns(board({
      items: [workspace('w', ['root'])],
      archivedSessionIds: ['kid', 'gone'] as SessionId[],
      sessions: [
        summary('root', { running: true }),
        summary('kid', { origin: 'subagent', parentId: 'root' as SessionId }),
        summary('gone'),
      ],
    }), { now: NOW })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.children).toEqual([])
  })

  it('activeOnly hides a done root with its whole family, and done orphan subagents alone', () => {
    const DAY_OLD = NOW - 25 * 60 * 60 * 1000
    const runs = deriveRuns(board({
      items: [workspace('w', ['dead', 'live'])],
      sessions: [
        summary('dead', { updatedAt: DAY_OLD }),
        summary('dead-kid', { origin: 'subagent', parentId: 'dead' as SessionId, updatedAt: DAY_OLD }),
        summary('live', { running: true }),
        summary('live-kid', { origin: 'subagent', parentId: 'live' as SessionId }),
        summary('orphan-done', { origin: 'subagent', parentId: 'unplaced' as SessionId, updatedAt: DAY_OLD }),
      ],
    }), { now: NOW })
    expect(runs.map(r => r.id)).toEqual(['live'])
    expect(runs[0]?.children.map(c => c.id)).toEqual(['live-kid'])
  })

  it('activeOnly: false keeps done families', () => {
    const runs = deriveRuns(board({
      items: [workspace('w', ['dead'])],
      sessions: [summary('dead', { updatedAt: NOW - 25 * 60 * 60 * 1000 })],
    }), { now: NOW, activeOnly: false })
    expect(runs.map(r => r.id)).toEqual(['dead'])
  })

  it('sessions absent from the workspace account but present in summaries are skipped; workspace order holds', () => {
    const runs = deriveRuns(board({
      items: [workspace('w', ['b', 'a', 'ghost'])],
      sessions: [summary('a'), summary('b')],
    }), { now: NOW })
    expect(runs.map(r => r.id)).toEqual(['b', 'a'])
  })
})
