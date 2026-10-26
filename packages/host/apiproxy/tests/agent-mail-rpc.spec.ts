import { randomBytes } from 'node:crypto'
import { nativeConsentCode } from '../src/native-consent-code.ts'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, vi } from 'vitest'
import { createApiProxy } from '../src/api-proxy.ts'
import { AgentMailForwardVerifier } from '../src/agent-mail-forward.ts'
import { toFetchHandler } from '../src/fetch/handler.ts'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'

const origin = 'http://antoncode.localhost:3742'
const workspaceId = WorkspaceId('workspace-1')
const sessionId = SessionId('session-1')
const agent = { id: sessionId } as Agent
const defaults = { defaultModelSelection: () => ({ provider: 'test', model: 'test' }), cwd: '/tmp' }
const request = <T>(payload: T) => ({ rpcId: 'rpc-1' as never, payload })

async function setup(seed?: Uint8Array, deliver?: (challenge: {
  requestId: string
  binding: string
  expiresAt: number
  summary: string
}) => boolean) {
  const ctx = new Context()
  await ctx.plugin(UserQuestionService)
  const live = new Map([[sessionId, agent]])
  ctx.provide('agents', { get: (id: string) => live.get(id as typeof sessionId) } as never)
  const address = vi.fn(async (current: Agent) => {
    if (live.get(current.id) !== current) throw new Error('stale agent')
    return { workspaceId, sessionId, inboxCursor: 0, unread: 0, peers: [], hasMorePeers: false }
  })
  const inbox = vi.fn(async () => ({ messages: [], inboxCursor: 0, hasMore: false }))
  const send = vi.fn(async () => ({ seq: 7 }))
  const ackInbox = vi.fn(async () => 7)
  ctx.provide('agentDirectQueue', { address, inbox, send, ackInbox } as never)
  const read = vi.fn(async () => ({ messages: [], cursor: 0, hasMore: false }))
  const publish = vi.fn(async () => ({ seq: 5 }))
  const ack = vi.fn(async () => 5)
  ctx.provide('agentQueue', { read, publish, ack } as never)
  const api = createApiProxy(ctx, {
    ...defaults, ...(seed ? { nativeConsentSeed: seed } : {}),
    ...(deliver ? { deliverAgentMailChallenge: async (_seed: Uint8Array, challenge: {
      requestId: string
      binding: string
      expiresAt: number
      summary: string
    }) => deliver(challenge) } : {}),
  })
  return { ctx, api, live, address, inbox, send, ackInbox, read, publish, ack }
}

describe('Agent Mail Host RPC', () => {
  it('authorizes the loopback UI without a native seed, then accepts the grant', async () => {
    const { api } = await setup()
    const response = await api.agentMail.authorize(request({ sessionId, operations: ['address', 'local-read'] }), origin)
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('authorize failed')
    const addressed = await api.agentMail.address(request({ sessionId, grant: response.result.value.grant }), origin)
    expect(addressed.result.ok).toBe(true)
  })

  it('refuses local authorization for an operation set outside the queue vocabulary', async () => {
    const { api } = await setup()
    const response = await api.agentMail.authorize(request({ sessionId, operations: ['address', 'address'] }), origin)
    expect(response.result.ok).toBe(false)
  })

  it('fails closed without native seed, even when a live Agent exists', async () => {
    const { api } = await setup()
    const response = await api.agentMail.begin(request({ sessionId, operations: ['address'] }), origin)
    expect(response.result.ok).toBe(false)
  })

  it('requires signed bridge origin proof at the HTTP carrier, not spoofable Origin', async () => {
    const { api } = await setup(randomBytes(32))
    const handler = toFetchHandler(api)
    const body = { type: 'client-request', rpcId: 'rpc-1', method: 'agentMail.begin',
      payload: { sessionId, operations: ['address'] } }
    const result = await handler.fetch('http://dsh.internal/api/agentMail.begin', {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
    })
    expect(result.status).toBe(403)
    expect(new AgentMailForwardVerifier(undefined).verify(new Request('http://127.0.0.1:3080/api/agentMail.begin')))
      .toBeUndefined()
  })

  it('issues only after native display succeeds, then enforces queue operations and revocation', async () => {
    const key = randomBytes(32)
    let displayed: { requestId: string; binding: string; expiresAt: number; summary: string } | undefined
    const { api, publish, send, read, inbox, ack, ackInbox, live, ctx } = await setup(key, (challenge) => {
      displayed = challenge
      return true
    })
    const began = await api.agentMail.begin(request({ sessionId, operations: [
      'address', 'local-read', 'local-send', 'local-ack', 'direct-read', 'direct-send', 'direct-ack',
    ] }), origin)
    expect(began.result.ok).toBe(true)
    if (!began.result.ok || !displayed) throw new Error('native challenge was not displayed')
    const display = displayed
    expect(JSON.stringify(began.result.value)).not.toContain(display.binding)
    expect(display.summary).toContain(sessionId)
    const redeemed = await api.agentMail.redeem(request({ sessionId, requestId: display.requestId,
      code: nativeConsentCode(key, display) }), origin)
    expect(redeemed.result.ok).toBe(true)
    if (!redeemed.result.ok) throw new Error('native code redemption failed')
    const grant = redeemed.result.value.grant
    expect((await api.agentMail.address(request({ sessionId, grant }), origin)).result.ok).toBe(true)
    expect((await api.agentMail.inbox(request({ sessionId, grant, channel: 'local' }), origin)).result.ok).toBe(true)
    expect((await api.agentMail.inbox(request({ sessionId, grant, channel: 'direct' }), origin)).result.ok).toBe(true)
    expect((await api.agentMail.send(request({ sessionId, grant, channel: 'local',
      recipients: [sessionId], body: 'local' }), origin)).result.ok).toBe(true)
    expect((await api.agentMail.send(request({ sessionId, grant, channel: 'direct',
      recipients: [SessionId('foreign')], body: 'direct' }), origin)).result.ok).toBe(true)
    expect((await api.agentMail.ack(request({ sessionId, grant, channel: 'local', throughSeq: 5 }), origin)).result.ok).toBe(true)
    expect((await api.agentMail.ack(request({ sessionId, grant, channel: 'direct', throughSeq: 7 }), origin)).result.ok).toBe(true)
    expect([publish.mock.calls.length, send.mock.calls.length, read.mock.calls.length,
      inbox.mock.calls.length, ack.mock.calls.length, ackInbox.mock.calls.length]).toEqual([1, 1, 1, 1, 1, 1])
    expect((await api.agentMail.revoke(request({ sessionId, grant }), origin)).result.ok).toBe(true)
    expect((await api.agentMail.address(request({ sessionId, grant }), origin)).result.ok).toBe(false)
    live.set(sessionId, { id: sessionId } as Agent)
    ctx.emit('agent/disposed', { agent })
  })

  it('refuses pairing when native display cannot be reached', async () => {
    const key = randomBytes(32)
    const { api } = await setup(key, () => false)
    const began = await api.agentMail.begin(request({ sessionId, operations: ['address'] }), origin)
    expect(began.result.ok).toBe(false)
  })

  it('refuses a wrong grant and keeps local/direct queue semantics distinct', async () => {
    const { api, read, inbox, publish, send, ack, ackInbox } = await setup(randomBytes(32))
    const denied = await api.agentMail.send(request({ sessionId, grant: 'wrong', channel: 'local',
      recipients: [sessionId], body: 'hello' }), origin)
    expect(denied.result.ok).toBe(false)
    expect(read).not.toHaveBeenCalled()
    expect(inbox).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(ack).not.toHaveBeenCalled()
    expect(ackInbox).not.toHaveBeenCalled()
  })
})
