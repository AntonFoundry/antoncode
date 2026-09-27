/**
 * orchestrator domain behavior: `board` composes the workspace registry rows
 * and the exact `session.list` summaries in one snapshot, and `act('kill')`
 * is the same business action as `session.cancel` — refusing unattached
 * sessions and cancelling the attached agent otherwise.
 */

import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`orchestrator-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function stubAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** The workspace spec's real-service harness, trimmed to the orchestrator inputs. */
async function harness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-orchestrator-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: () => {
          unregister()
          return Promise.resolve()
        },
      }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  ctx.provide('directoryPicker', { capability: () => ({ kind: 'native', pick: async () => null }) } as never)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: root,
  })
  return { api, ctx, root }
}

function stageDir(root: string, name: string): string {
  const path = join(root, name)
  mkdirSync(path)
  return path
}

describe('orchestrator.board', () => {
  it('composes workspace rows and session summaries in one snapshot', async () => {
    const { api, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'mission-control') })))
    // A session joins its workspace at creation; agents attach separately.
    const created = expectOk(await api.sessions.create(request({ workspaceId: workspace.workspace.workspaceId })))

    const board = expectOk(await api.orchestrator.board(request({})))

    expect(board.items).toHaveLength(1)
    expect(board.items[0]?.sessionIds).toEqual([created.sessionId])
    const summary = board.sessions.find(candidate => candidate.sessionId === created.sessionId)
    expect(summary).toBeDefined()
    expect(summary?.running).toBe(false)
  })

  it('serves session.list summaries verbatim', async () => {
    const { api, ctx } = await harness()
    ctx.sessions.create()
    const board = expectOk(await api.orchestrator.board(request({})))
    const listed = expectOk(await api.sessions.list(request({})))
    expect(board.sessions).toEqual(listed.items)
  })
})

describe('orchestrator.act', () => {
  it('kill cancels the attached agent through the shared session.cancel action', async () => {
    const { api, ctx } = await harness()
    const session = ctx.sessions.create()
    const cancel = vi.fn()
    const agent = stubAgent(session)
    agent.cancel = cancel
    ctx.agents.register(agent)
    const result = expectOk(await api.orchestrator.act(request({ sessionId: session.id, action: 'kill' })))
    expect(result).toEqual({ accepted: true })
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  })

  it('kill refuses a session that is not attached', async () => {
    const { api } = await harness()
    const response = await api.orchestrator.act(request({ sessionId: SessionId('missing') as never, action: 'kill' }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  })
})
