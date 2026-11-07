import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('JSONL automatic failover persistence', () => {
  it('retains switch, attempted routes and exhaustion without turning diagnostics into model history', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SessionStore)
    root = await mkdtemp(join(tmpdir(), 'dsh-failover-jsonl-'))
    await ctx.plugin(JsonlSessionPersistence, { root })
    const session = ctx.sessions.create(SessionId('failover-jsonl'))
    const handle = await ctx.sessionPersistence.create(session.header)
    const primary = { provider: 'alpha', model: 'primary' }
    const backup = { provider: 'beta', model: 'backup' }
    const attempts = [{ selection: primary, code: 'QUOTA' }, { selection: backup, code: 'SERVER' }]
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const first = session.append('llm/failover-attempt', { primary, attempt: attempts[0]!, startedAt: 100, turn: 1, step: 1 })
    const switched = session.append('llm/failover', {
      primary, from: primary, to: backup, failureCode: 'QUOTA', reason: 'failure', cooldownUntil: 300_100, turn: 1, step: 1,
    })
    const second = session.append('llm/failover-attempt', { primary, attempt: attempts[1]!, startedAt: 100, turn: 1, step: 1 })
    const exhausted = session.append('llm/failover-exhausted', { primary, attempted: attempts, turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'FAILOVER_EXHAUSTED', message: 'No route available' } } })
    expect(session.deriveMessages()).toEqual([])
    await ctx.sessions.flush(session)
    await handle.close()
    const reader = await ctx.sessionPersistence.open(session.id, 'read')
    try {
      const loaded = await reader.read()
      expect(loaded.events.filter(event => event.type.startsWith('llm/failover'))).toEqual([first, switched, second, exhausted])
    } finally {
      await reader.close()
    }
  })
})
