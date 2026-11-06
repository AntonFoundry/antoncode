/** Board callbacks over real Client Session ownership and endpoint-named Remote mocks. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, onTestFinished, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp, type ClientTestFixtures } from '../../../test-support/client-runtime/src/assembly/index.ts'
import { ClientSessions } from '../../../api/session-controller/src/client/sessions/service.ts'
import { FOLLOW, followScript, sessionWorld } from '../../../api/session-controller/tests/remote/session.client.ts'
import { createBoardSessionActions } from '../src/client/board-session-actions.ts'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })
const PANE = 'board-pane' as SessionId
const OTHER = 'other-pane' as SessionId

const setup = async (fixtures: Pick<ClientTestFixtures, 'mock' | 'start'>) => {
  fixtures.mock.load(sessionWorld)
  const client = await fixtures.start()
  const ctx = new Context()
  const sessions = new ClientSessions(ctx, client.ctx.remote)
  onTestFinished(() => ctx.fiber.dispose())
  for (const sessionId of [PANE, OTHER]) {
    sessions.handleSessionAdded({ sessionId, updatedAt: 1, running: false, blank: false, agentAvailable: true })
  }
  const lifetime = new AbortController()
  onTestFinished(() => lifetime.abort())
  return { sessions, lifetime, ctx, actions: createBoardSessionActions(sessions, lifetime.signal) }
}

describe('board Session commands', () => {
  it('routes queue, steer, and cancel to the addressed pane and releases each operation', async ({ mock, start }) => {
    const fixtures = { mock, start }
    const { sessions, actions } = await setup(fixtures)
    const other = sessions.retain(OTHER, { source: 'testView' })
    onTestFinished(() => other.release())
    await other.ready

    await actions.promptSession(PANE, 'queued text', 'queue')
    await actions.promptSession(PANE, 'steering text', 'steer')
    await actions.interruptSession(PANE)

    expect(fixtures.mock.remote.session.prompt).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: PANE, mode: 'queue', content: [{ type: 'text', text: 'queued text' }],
    }))
    expect(fixtures.mock.remote.session.prompt).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: PANE, mode: 'steer', content: [{ type: 'text', text: 'steering text' }],
    }))
    expect(fixtures.mock.remote.session.cancel).toHaveBeenCalledWith({ sessionId: PANE })
    expect(sessions.retainInfo(PANE).getSnapshot().referenceCount).toBe(0)
    expect(sessions.retainInfo(OTHER).getSnapshot().referenceCount).toBe(1)
  }, 60_000)

  it('holds one temporary reference through prompt settlement, sharing an existing generation', async ({ mock, start }) => {
    const fixtures = { mock, start }
    const { sessions, actions } = await setup(fixtures)
    const view = sessions.retain(PANE, { source: 'testView' })
    onTestFinished(() => view.release())
    await view.ready
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof fixtures.mock.remote.session.prompt>>>()
    onTestFinished(() => pending.resolve(ok({ accepted: true })))
    fixtures.mock.remote.session.prompt.mockReturnValueOnce(pending.promise)
    const prompting = actions.promptSession(PANE, 'one admission', 'queue')
    await vi.waitFor(() => expect(fixtures.mock.remote.session.prompt).toHaveBeenCalledTimes(1))
    expect(sessions.retainInfo(PANE).getSnapshot()).toEqual({
      referenceCount: 2, retainedBy: { testView: 1, controllerOperation: 1 },
    })
    expect(fixtures.mock.log.requests(FOLLOW)).toHaveLength(1)
    pending.resolve(ok({ accepted: true }))
    await prompting
    expect(sessions.retainInfo(PANE).getSnapshot()).toEqual({ referenceCount: 1, retainedBy: { testView: 1 } })
  })

  it('propagates exact prompt and cancel business errors and releases ownership', async ({ mock, start }) => {
    const fixtures = { mock, start }
    const { sessions, actions } = await setup(fixtures)
    const denied = new RemoteError('session/not-found', 'This session is unavailable', { sessionId: PANE })
    fixtures.mock.remote.session.prompt.mockResolvedValueOnce({ ok: false, error: denied })
    await expect(actions.promptSession(PANE, 'keep draft', 'steer')).rejects.toBe(denied)
    fixtures.mock.remote.session.cancel.mockResolvedValueOnce({ ok: false, error: denied })
    await expect(actions.interruptSession(PANE)).rejects.toBe(denied)
    expect(sessions.retainInfo(PANE).getSnapshot().referenceCount).toBe(0)
  })

  it('routes a listed child through its exact durable parent address', async ({ mock, start }) => {
    const fixtures = { mock, start }
    const { sessions, actions } = await setup(fixtures)
    sessions.handleSessionAdded({ sessionId: PANE, parentSessionId: OTHER, origin: 'subagent',
      updatedAt: 1, running: false, blank: false, agentAvailable: true })
    await actions.promptSession(PANE, 'continue child', 'queue')
    await actions.interruptSession(PANE)
    expect(fixtures.mock.remote.subagents.prompt).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: OTHER, childSessionId: PANE, delivery: 'queue',
      content: [{ type: 'text', text: 'continue child' }],
    }))
    expect(fixtures.mock.remote.subagents.interruptByParent).toHaveBeenCalledWith(PANE, OTHER, 'continuable')
    expect(fixtures.mock.remote.session.prompt).not.toHaveBeenCalled()
    expect(fixtures.mock.remote.session.cancel).not.toHaveBeenCalled()
    expect(sessions.retainInfo(PANE).getSnapshot().referenceCount).toBe(0)
  })

  it('aborts pending acquisition without sending and releases its only reference', async ({ mock, start }) => {
    const fixtures = { mock, start }
    const { sessions, actions, lifetime } = await setup(fixtures)
    const opening = Promise.withResolvers<Awaited<ReturnType<typeof fixtures.mock.remote.session.page>>>()
    onTestFinished(() => opening.resolve(ok({ cursor: -1, records: [], hasMore: false })))
    fixtures.mock.stream(FOLLOW, followScript(opening.promise))
    const prompting = actions.promptSession(PANE, 'not sent', 'queue')
    const reason = new Error('board disposed')
    lifetime.abort(reason)
    await expect(prompting).rejects.toBe(reason)
    expect(sessions.retainInfo(PANE).getSnapshot().referenceCount).toBe(0)
    expect(fixtures.mock.remote.session.prompt).not.toHaveBeenCalled()
  })

  it('releases an acquiring operation when the Session Controller is disposed', async ({ mock, start }) => {
    const { sessions, actions, ctx } = await setup({ mock, start })
    const opening = Promise.withResolvers<Awaited<ReturnType<typeof mock.remote.session.page>>>()
    onTestFinished(() => opening.resolve(ok({ cursor: -1, records: [], hasMore: false })))
    mock.stream(FOLLOW, followScript(opening.promise))
    const prompting = actions.promptSession(PANE, 'not admitted', 'queue')
    const outcome = expect(prompting).rejects.toThrow()
    await ctx.fiber.dispose()
    await outcome
    expect(sessions.retainInfo(PANE).getSnapshot().referenceCount).toBe(0)
    expect(mock.remote.session.prompt).not.toHaveBeenCalled()
  })

  it('rejects after Session Controller disposal without acquiring ownership', async ({ mock, start }) => {
    const fixtures = { mock, start }
    const { sessions, actions, ctx } = await setup(fixtures)
    await ctx.fiber.dispose()
    await expect(actions.interruptSession(PANE)).rejects.toThrow('Session Controller is disposed')
    expect(sessions.retainInfo(PANE).getSnapshot().referenceCount).toBe(0)
    expect(fixtures.mock.remote.session.cancel).not.toHaveBeenCalled()
  })
})

describe('board model projection reads', () => {
  it('reads the next route from the catalog without opening history or retaining a Session', async ({ mock, start }) => {
    const fixtures = { mock, start }
    const { sessions, actions } = await setup(fixtures)
    sessions.handleControlFrame({ type: 'projection', sessionId: PANE, key: 'modelSelection', seq: SessionSeq(2),
      value: { lastUsed: { provider: 'old-provider', model: 'old-model' }, next: { provider: 'next-provider', model: 'next-model' } } })
    await Promise.resolve()
    expect(await actions.fetchSessionModel(PANE)).toBe('next-provider/next-model')
    expect(fixtures.mock.remote.session.projections).not.toHaveBeenCalled()
    expect(fixtures.mock.log.requests(FOLLOW)).toHaveLength(0)
    expect(sessions.retainInfo(PANE).getSnapshot().referenceCount).toBe(0)
  })

  it('refreshes cold projections and uses lastUsed when there is no next route', async ({ mock, start }) => {
    const fixtures = { mock, start }
    const { sessions, actions } = await setup(fixtures)
    fixtures.mock.remote.session.projections.mockResolvedValueOnce(ok({ kind: 'sequenced', asOfSeq: 2,
      values: { modelSelection: { next: null, lastUsed: { provider: 'provider', model: 'model' } } } }))
    expect(await actions.fetchSessionModel(PANE)).toBe('provider/model')
    expect(fixtures.mock.remote.session.projections).toHaveBeenCalledWith({ sessionId: PANE })
    expect(fixtures.mock.log.requests(FOLLOW)).toHaveLength(0)
    expect(sessions.retainInfo(PANE).getSnapshot().referenceCount).toBe(0)
  })

  it('returns absent routes as absent and propagates exact projection errors', async ({ mock, start }) => {
    const fixtures = { mock, start }
    const { actions } = await setup(fixtures)
    expect(await actions.fetchSessionModel(PANE)).toBeUndefined()
    const denied = new RemoteError('session/not-found', 'This session is unavailable', { sessionId: OTHER })
    fixtures.mock.remote.session.projections.mockResolvedValueOnce({ ok: false, error: denied })
    await expect(actions.fetchSessionModel(OTHER)).rejects.toBe(denied)
    expect(fixtures.mock.log.requests(FOLLOW)).toHaveLength(0)
  })
})
