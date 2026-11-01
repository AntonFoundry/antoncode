import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as QueueTools from '../src/index.ts'

const agent = { id: 'session-a', session: { header: { id: 'session-a', cwd: '/workspace' } } } as never
const otherAgent = { id: 'session-b', session: { header: { id: 'session-b', cwd: '/workspace' } } } as never
let call = 0

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const queue = {
    identities: vi.fn(async (caller: { id: string }) => ({ sessionId: caller.id, workspaceId: 'workspace-1', sessionIds: ['session-a', 'session-b'] })),
    subscribe: vi.fn(async () => () => undefined),
    publish: vi.fn(async (_agent: unknown, request: object) => ({ id: 'msg-1', seq: 1, ...request })),
    read: vi.fn(async () => ({ messages: [{ id: 'msg-1', seq: 1, recipients: ['session-a'] }], cursor: 0, hasMore: false })),
    ack: vi.fn(async () => 1),
  }
  // The mock stays behind the same service boundary as production: tools
  // cannot manufacture a sender or route a message without the queue service.
  ctx.provide('agentQueue', queue as never)
  await ctx.plugin(QueueTools)
  function execute(name: string, args: unknown, caller?: unknown) {
    return executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId(`queue-call-${++call}`),
      name,
      arguments: args,
      ...(caller === undefined ? {} : { agent: caller as never }),
    })
  }
  return { ctx, queue, execute }
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('model-facing agent queue tools', () => {
  it('registers five globally named tools without an agent scope', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('agent_queue_')).sort())
      .toEqual(['agent_queue_ack', 'agent_queue_address', 'agent_queue_read', 'agent_queue_send', 'agent_queue_subscribe'])
  })

  it('rejects an agentless call and passes the exact calling Agent through to the service', async () => {
    const { execute, queue } = await setup()
    const absent = await execute('agent_queue_address', {})
    expect(absent.isError).toBe(true)
    expect(queue.identities).not.toHaveBeenCalled()
    expect((await execute('agent_queue_address', {}, agent)).isError).toBe(false)
    expect((await execute('agent_queue_address', {}, otherAgent)).isError).toBe(false)
    expect(queue.identities).toHaveBeenNthCalledWith(1, agent)
    expect(queue.identities).toHaveBeenNthCalledWith(2, otherAgent)
  })

  it('subscribes and sends to multiple recipients without waking recipients', async () => {
    const { queue, execute } = await setup()
    const subscription = await execute('agent_queue_subscribe', { workspace_id: 'workspace-1' }, agent)
    expect(subscription.isError).toBe(false)
    expect(queue.subscribe).toHaveBeenCalledWith(agent, 'workspace-1')
    const sent = await execute('agent_queue_send', {
      workspace_id: 'workspace-1', recipients: ['session-b', 'session-c'], workspace_wide: true, body: 'coordinate edits',
    }, agent)
    expect(sent.isError).toBe(false)
    expect(queue.publish).toHaveBeenCalledWith(agent, {
      workspaceId: 'workspace-1', recipients: ['session-b', 'session-c'], workspaceWide: true, body: 'coordinate edits',
    })
    expect(Object.keys(queue)).toEqual(['identities', 'subscribe', 'publish', 'read', 'ack'])
  })

  it('rejects invalid or cross-workspace requests before publishing', async () => {
    const { queue, execute } = await setup()
    for (const args of [
      { recipients: [], body: 'hello' },
      { recipients: ['session-b', 'session-b'], body: 'hello' },
      { recipients: ['session-b'], body: ' ' },
      { recipients: ['session-b'], body: 'x'.repeat(65537) },
      { recipients: ['session-b'], workspace_id: ' ', body: 'hello' },
    ]) {
      expect((await execute('agent_queue_send', args, agent)).isError).toBe(true)
    }
    expect(queue.publish).not.toHaveBeenCalled()
  })

  it('reads and acknowledges through each caller’s durable service cursor', async () => {
    const { queue, execute } = await setup()
    const read = await execute('agent_queue_read', { workspace_id: 'workspace-1', cursor: 0, limit: 2 }, agent)
    expect(read.isError).toBe(false)
    expect(queue.read).toHaveBeenCalledWith(agent, { workspaceId: 'workspace-1', cursor: 0, limit: 2 })
    expect(text(read)).toContain('msg-1')
    const ack = await execute('agent_queue_ack', { workspace_id: 'workspace-1', through_seq: 1 }, agent)
    expect(ack.isError).toBe(false)
    expect(queue.ack).toHaveBeenCalledWith(agent, 'workspace-1', 1)
    expect(text(ack)).toContain('"cursor":1')
    expect((await execute('agent_queue_read', { limit: 101 }, agent)).isError).toBe(true)
    expect((await execute('agent_queue_ack', { workspace_id: 'workspace-1', through_seq: -1 }, agent)).isError).toBe(true)
  })
})
