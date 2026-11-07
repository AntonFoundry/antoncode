import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ComposerRoute } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/composer-routes.ts'
import { apply } from '../src/client/index.ts'
import { agentMentionToken } from '../src/client/mentions.ts'
import { setAgentMailChannel } from '../src/client/composer-targets.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function fixture(extraPeers: { sessionId: string; workspaceId: string; transport: string }[] = []) {
  const ctx = new Context()
  contexts.push(ctx)
  const remote = {
    address: vi.fn(async () => ({ ok: true, value: {
      sessionId: 'self', workspaceId: 'w1', inboxCursor: 0, unread: 0,
      peers: [
        { sessionId: 'self', workspaceId: 'w1', transport: 'workspace-queue' },
        { sessionId: 'local', workspaceId: 'w1', transport: 'workspace-queue' },
        { sessionId: 'remote', workspaceId: 'w2', transport: 'direct' },
        ...extraPeers,
      ], hasMorePeers: false,
    } })),
    inbox: vi.fn(async () => ({ ok: true, value: { messages: [], cursor: 0, hasMore: false } })),
    send: vi.fn(async () => ({ ok: true, value: { seq: 1 } })),
    ack: vi.fn(async () => ({ ok: true, value: { cursor: 1 } })),
  }
  let route: ComposerRoute | undefined
  let source: InputTriggerSource | undefined
  let gateway: { authorize(sessionId: string): Promise<void> } | undefined
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('conversation', {
    composerRoutes: { register: (_id: string, value: ComposerRoute) => { route = value; return () => {} } },
    activeView: () => 'agent-mail',
  } as never)
  ctx.provide('uiConversation', { events: { register: () => () => {} }, views: { register: () => () => {} } } as never)
  ctx.provide('inputTriggers', { registerSource: (value: InputTriggerSource) => { source = value; return () => {} } } as never)
  ctx.provide('remote', { agentMail: remote } as never)
  ctx.provide('remote.agentMail', {} as never)
  ctx.provide('slots', {
    inject: (_name: string, callback: () => void) => { callback(); return () => {} },
    register: (options: { inject(sessionId: string): { gateway: { authorize(sessionId: string): Promise<void> } } }) => {
      gateway = options.inject('self').gateway
      return () => {}
    },
  } as never)
  apply(ctx)
  if (route === undefined || source === undefined || gateway === undefined) throw new Error('mail registration missing')
  await gateway.authorize('self')
  return { route, source, remote }
}

const session = { sessionId: 'self' as never }
const request = (text: string) => ({ sessionId: 'self' as never, text, imageIds: [], mode: 'queue' as const })

describe('Agent Mail channel routing', () => {
  it.each(['local', 'direct'] as const)('suggests only %s-compatible peers', async (channel) => {
    const { source } = await fixture()
    setAgentMailChannel('self', channel)
    const candidates = await source.candidates(session, { query: '' } as never)
    expect(candidates.map(candidate => candidate.name)).toEqual([agentMentionToken(channel === 'local' ? 'local' : 'remote')])
    expect(source.lexicon?.(session)).toEqual([agentMentionToken(channel === 'local' ? 'local' : 'remote')])
  })

  it.each(['local', 'direct'] as const)('rejects known wrong-channel mentions in %s without sending or broadcasting', async (channel) => {
    const { route, remote } = await fixture()
    setAgentMailChannel('self', channel)
    const recipient = channel === 'local' ? 'remote' : 'local'
    await expect(route.submit(request(`@${agentMentionToken(recipient)} hello`))).rejects.toThrow(/channel/i)
    expect(remote.send).not.toHaveBeenCalled()
  })

  it('submits several cross-workspace recipients in one atomic Remote send', async () => {
    const { route, remote } = await fixture([{ sessionId: 'remote-two', workspaceId: 'w3', transport: 'direct' }])
    setAgentMailChannel('self', 'direct')
    const text = `@${agentMentionToken('remote')} @${agentMentionToken('remote-two')} hello`
    await route.submit(request(text))
    expect(remote.send).toHaveBeenCalledTimes(1)
    expect(remote.send).toHaveBeenCalledWith('self', 'direct', ['remote', 'remote-two'], text)
  })

  it('keeps local unaddressed broadcasts and correctly addressed sends', async () => {
    const { route, remote } = await fixture()
    setAgentMailChannel('self', 'local')
    await route.submit(request('hello workspace'))
    expect(remote.send).toHaveBeenLastCalledWith('self', 'local', [], 'hello workspace', true)
    await route.submit(request(`@${agentMentionToken('local')} hello`))
    expect(remote.send).toHaveBeenLastCalledWith('self', 'local', ['local'], `@${agentMentionToken('local')} hello`, false)
    setAgentMailChannel('self', 'direct')
    await route.submit(request(`@${agentMentionToken('remote')} hello`))
    expect(remote.send).toHaveBeenLastCalledWith('self', 'direct', ['remote'], `@${agentMentionToken('remote')} hello`)
  })
})
