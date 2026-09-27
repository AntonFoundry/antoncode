/** contract.ts pure folds: error dedupe, tree flatten, triage filters, stalemate detection. */
import { describe, expect, it } from 'vitest'
import {
  dedupeErrors, detectStalemate, done, flattenRuns, needsYou, NEEDS_YOU, runningRuns,
  type Run,
} from '../src/client/contract.ts'

const run = (id: string, state: Run['state'], children: Run[] = []): Run => ({
  id,
  role: 'custom',
  title: id,
  state,
  tier: 'reasoning',
  mode: 'interactive',
  tokens: { in: 0, out: 0 },
  costUsd: 0,
  wallMs: 0,
  errors: [],
  children,
})

describe('dedupeErrors', () => {
  it('collapses same-signature rows, keeping count and first/last seen', () => {
    expect(dedupeErrors([
      { sig: 'bash: HTTP 400', ts: 10 },
      { sig: 'bash: HTTP 400', ts: 4 },
      { sig: 'bash: HTTP 400', ts: 7 },
      { sig: 'web: timeout', ts: 20 },
    ])).toEqual([
      { sig: 'bash: HTTP 400', count: 3, firstSeen: 4, lastSeen: 10 },
      { sig: 'web: timeout', count: 1, firstSeen: 20, lastSeen: 20 },
    ])
  })

  it('returns empty for no events', () => {
    expect(dedupeErrors([])).toEqual([])
  })
})

describe('flattenRuns', () => {
  it('walks the tree depth-first, root first', () => {
    const tree = run('a', 'running', [run('a1', 'queued'), run('a2', 'done', [run('a2a', 'done')])])
    expect(flattenRuns(tree).map(r => r.id)).toEqual(['a', 'a1', 'a2', 'a2a'])
  })
})

describe('triage filters', () => {
  const runs = [run('b', 'blocked'), run('r', 'running'), run('q', 'queued'), run('d', 'done'), run('f', 'failed')]

  it('needsYou picks every NEEDS_YOU state', () => {
    expect(needsYou(runs).map(r => r.id)).toEqual(['b', 'f'])
    expect(NEEDS_YOU).toContain('verifying')
    expect(NEEDS_YOU).toContain('stalemate')
  })

  it('runningRuns picks running and queued', () => {
    expect(runningRuns(runs).map(r => r.id)).toEqual(['r', 'q'])
  })

  it('done picks done only', () => {
    expect(done(runs).map(r => r.id)).toEqual(['d'])
  })
})

describe('detectStalemate', () => {
  it('fires after limit consecutive flat rounds', () => {
    expect(detectStalemate([{ diffDelta: 0 }, { diffDelta: 0 }, { diffDelta: 0 }])).toBe(true)
    expect(detectStalemate([{ diffDelta: 5 }, { diffDelta: 0 }, { diffDelta: 0 }, { diffDelta: 0 }])).toBe(true)
  })

  it('stays silent below the limit or on any diff movement', () => {
    expect(detectStalemate([{ diffDelta: 0 }, { diffDelta: 0 }])).toBe(false)
    expect(detectStalemate([{ diffDelta: 0 }, { diffDelta: 3 }, { diffDelta: 0 }])).toBe(false)
  })
})
