import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, ReasoningEffortId, resolveRetryPolicy, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as retry from '../src/index.ts'

const primary = { provider: 'alpha', model: 'primary' }
const backup = { provider: 'beta', model: 'backup' }
type Entry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

class RouteAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly noRetries = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'failover test policy')

  constructor(
    private readonly entries: Entry[],
    private readonly metadata: Partial<LlmResolvedModelInfo> = { context: { contextWindow: 100_000 }, inputModalities: ['text', 'image'] },
  ) { super() }

  override providerRetryPolicy() { return this.noRetries }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, defaultMaxTokens: 1_024, ...this.metadata })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('failover test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }
}

function response(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function* partialTool(): AsyncGenerator<StreamChunk> {
  const id = ToolCallId('uncommitted-failover-call')
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: 'danger', argumentsDelta: '{}' }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'danger', arguments: '{}' } }
  throw new LlmError('stream failed after tool output', 'SERVER')
}

let context: Context | undefined
let policyFiber: Fiber | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.useRealTimers()
})

async function harness(
  source: RouteAdapter,
  target: RouteAdapter,
  options: NonNullable<retry.Config['failover']> = {},
): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  ctx.llm.registerAdapter(['alpha'], source)
  ctx.llm.registerAdapter(['beta'], target)
  policyFiber = await ctx.plugin(retry, {
    failover: {
      enabled: true,
      chains: [{ primary, fallbacks: [backup] }],
      sameRouteRetries: 0,
      retryDelayMs: 1,
      cooldownMs: 1_000,
      maxAttempts: 8,
      maxElapsedMs: 10_000,
      ...options,
    },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

async function send(agent: Agent): Promise<void> {
  const idle = agent.whenIdle()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue safely' }], source: { kind: 'user' } }))
  await idle
}

function expectReply(agent: Agent, text: string): void {
  expect(agent.session.deriveMessages().at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text }] })
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

describe('automatic cross-route failover through the agent loop', () => {
  it.each(['QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'OVERLOADED', 'MODEL_UNAVAILABLE', 'SERVER'])(
    'recovers %s on the fallback within the same logical step', async (code) => {
      const source = new RouteAdapter([new LlmError('primary unavailable', code)])
      const target = new RouteAdapter([response('backup succeeded')])
      const ctx = await harness(source, target)
      const agent = await ctx.agentLoop.create(SessionId(`failover-${code}`), primary)

      await send(agent)

      expect(source.requests).toHaveLength(1)
      expect(target.requests).toHaveLength(1)
      expect(target.requests[0]?.messages.slice(0, -1)).toEqual(source.requests[0]?.messages)
      expect(target.requests[0]?.messages.at(-1)).toMatchObject({
        role: 'user',
        source: { kind: 'model-failover' },
        content: [{ type: 'text', text: `[automatic model switch: alpha/primary → beta/backup; ${code}]` }],
      })
      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'step/start').map(event => event.data)).toEqual([{ turn: 1, step: 1 }])
      expect(events.filter(event => event.type === 'request/header').map(event => event.data.header.config.provider)).toEqual(['alpha', 'beta'])
      expect(events.filter(event => event.type === 'llm/failover')).toMatchObject([{
        data: { primary, from: primary, to: backup, reason: 'failure', failureCode: code, turn: 1, step: 1 },
      }])
      expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
      expectReply(agent, 'backup succeeded')
    },
  )

  it('retries the current route before advancing to the fallback', async () => {
    vi.useFakeTimers()
    const source = new RouteAdapter([new LlmError('busy', 'SERVER'), new LlmError('still busy', 'SERVER')])
    const target = new RouteAdapter([response('backup')])
    const ctx = await harness(source, target, { sameRouteRetries: 1 })
    const agent = await ctx.agentLoop.create(SessionId('failover-local-retry'), primary)
    const scheduled = new Promise<void>((resolve) => {
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'llm/failover-attempt') resolve()
      })
    })
    const idle = send(agent)
    await scheduled
    await vi.runAllTimersAsync()
    await idle

    expect(source.requests).toHaveLength(2)
    expect(target.requests).toHaveLength(1)
    expectReply(agent, 'backup')
  })

  it.each(['AUTH', 'MISSING', 'MISSING_CREDENTIAL', 'INVALID_REQUEST', 'CONTEXT', 'ABORTED', 'TIMEOUT', 'TRANSPORT'])(
    'does not cross routes for excluded %s failures', async (code) => {
      const source = new RouteAdapter([new LlmError('failure must remain local', code)])
      const target = new RouteAdapter([])
      const ctx = await harness(source, target)
      const agent = await ctx.agentLoop.create(SessionId(`failover-excluded-${code}`), primary)

      await send(agent)

      expect(source.requests).toHaveLength(1)
      expect(target.requests).toHaveLength(0)
      expect(agent.session.snapshotEvents().some(event => event.type === 'llm/failover')).toBe(false)
      expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
    },
  )

  it('skips every route on a provider after its account quota is exhausted', async () => {
    const source = new RouteAdapter([new LlmError('account quota', 'ACCOUNT_QUOTA')])
    const target = new RouteAdapter([response('independent provider')])
    const ctx = await harness(source, target, {
      chains: [{ primary, fallbacks: [{ provider: 'alpha', model: 'same-account' }, backup] }],
    })
    const agent = await ctx.agentLoop.create(SessionId('failover-provider-quota'), primary)
    await send(agent)
    expect(source.requests.map(request => request.model)).toEqual(['primary'])
    expect(target.requests).toHaveLength(1)
    expectReply(agent, 'independent provider')
  })

  it('does not extend its deadline to obey an over-budget provider retry instruction', async () => {
    const source = new RouteAdapter([new LlmError('wait too long', 'RATE_LIMIT', { providerRetryAfterMs: 60_000 })])
    const target = new RouteAdapter([response('within budget')])
    const ctx = await harness(source, target, { sameRouteRetries: 1, maxElapsedMs: 100 })
    const agent = await ctx.agentLoop.create(SessionId('failover-retry-after-budget'), primary)
    await send(agent)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(1)
    expectReply(agent, 'within budget')
  })

  it('isolates cooldown state between sessions sharing the same policy', async () => {
    const source = new RouteAdapter([new LlmError('quota for first session', 'QUOTA'), response('second session primary')])
    const target = new RouteAdapter([response('first session backup'), response('first session sticky')])
    const ctx = await harness(source, target)
    const first = await ctx.agentLoop.create(SessionId('failover-isolation-first'), primary)
    const second = await ctx.agentLoop.create(SessionId('failover-isolation-second'), primary)
    await send(first)
    await send(second)
    await send(first)
    expect(source.requests).toHaveLength(2)
    expect(target.requests).toHaveLength(2)
    expectReply(second, 'second session primary')
    expectReply(first, 'first session sticky')
  })

  it('replays durable cooldown after the policy plugin is unloaded and mounted again', async () => {
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')])
    const target = new RouteAdapter([response('first backup'), response('backup after remount')])
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId('failover-replay-remount'), primary)
    await send(agent)
    await policyFiber!.dispose()
    policyFiber = await ctx.plugin(retry, { failover: { enabled: true, sameRouteRetries: 0, cooldownMs: 60_000,
      chains: [{ primary, fallbacks: [backup] }] } })
    await send(agent)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(2)
    expectReply(agent, 'backup after remount')
  })

  it.each([
    [401, 'RATE_LIMIT'], [403, 'RATE_LIMIT'], [401, 'QUOTA'], [403, 'QUOTA'],
  ] as const)('does not fail over auth status %s even when the code is %s', async (status, code) => {
    const source = new RouteAdapter([new LlmError('authentication denied', code, { status })])
    const target = new RouteAdapter([])
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId(`failover-auth-status-${status}`), primary)
    await send(agent)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/failover')).toBe(false)
  })

  it.each([false, true])('recovers unavailable preparation only after pending input is measured (meter mounted: %s)', async (withMeter) => {
    const source = new RouteAdapter([])
    vi.spyOn(source, 'resolveModel').mockRejectedValue(new LlmError('primary model retired', 'MODEL_UNAVAILABLE'))
    const target = new RouteAdapter(withMeter ? [response('prepared backup')] : [], {
      context: { contextWindow: 100_000 }, defaultMaxTokens: 1_024,
    })
    const ctx = await harness(source, target)
    if (withMeter) await ctx.plugin(TokenMeter)
    const agent = await ctx.agentLoop.create(SessionId(`failover-unavailable-preparation-${withMeter}`), primary)
    await send(agent)
    expect(source.requests).toHaveLength(0)
    expect(target.requests).toHaveLength(withMeter ? 1 : 0)
    if (withMeter) {
      expect(target.requests[0]?.messages.filter(message => message.role === 'user' && message.source?.kind === 'user')).toHaveLength(1)
      expectReply(agent, 'prepared backup')
    } else {
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'FAILOVER_EXHAUSTED' } } },
      })
    }
  })

  it('does not infer failover eligibility from an untyped error message', async () => {
    const source = new RouteAdapter([new Error('RATE_LIMIT 429 overloaded quota')])
    const target = new RouteAdapter([])
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId('failover-untyped'), primary)
    await send(agent)
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/failover')).toBe(false)
  })

  it('reports every attempted route when the chain is exhausted', async () => {
    const source = new RouteAdapter([new LlmError('primary unavailable', 'QUOTA')])
    const target = new RouteAdapter([new LlmError('fallback unavailable', 'OVERLOADED')])
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId('failover-exhausted'), primary)
    await send(agent)

    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/failover-exhausted')).toMatchObject([{
      data: { primary, turn: 1, step: 1, attempted: [{ selection: primary, code: 'QUOTA' }, { selection: backup, code: 'OVERLOADED' }] },
    }])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'error', error: {
        code: 'FAILOVER_EXHAUSTED',
        message: 'Automatic model failover exhausted: alpha/primary (QUOTA); beta/backup (OVERLOADED). Check provider availability or choose a working model.',
      } } },
    })
  })

  it('stops before a fallback dispatch when the request-attempt budget is exhausted', async () => {
    const source = new RouteAdapter([new LlmError('primary quota', 'QUOTA')])
    const target = new RouteAdapter([])
    const ctx = await harness(source, target, { maxAttempts: 1 })
    const agent = await ctx.agentLoop.create(SessionId('failover-attempt-budget'), primary)
    await send(agent)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/failover-exhausted')).toHaveLength(1)
  })

  it('counts incompatible candidates against the attempt budget before dispatching later routes', async () => {
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')])
    const target = new RouteAdapter([], { context: { contextWindow: 50_000 } })
    const ctx = await harness(source, target, {
      maxAttempts: 2,
      chains: [{ primary, fallbacks: [backup, { provider: 'gamma', model: 'later' }] }],
    })
    const later = new RouteAdapter([response('must not dispatch')])
    ctx.llm.registerAdapter(['gamma'], later)
    const agent = await ctx.agentLoop.create(SessionId('failover-candidate-budget'), primary)
    await send(agent)
    expect(target.requests).toHaveLength(0)
    expect(later.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/failover-exhausted')).toMatchObject([{
      data: { attempted: [{ selection: primary, code: 'QUOTA' }, { selection: backup, code: 'SMALLER_CONTEXT_CAPACITY' }] },
    }])
  })

  it('rechecks the elapsed budget after asynchronous candidate metadata resolves', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')])
    const target = new RouteAdapter([response('must not dispatch')])
    const ctx = await harness(source, target, { maxElapsedMs: 100 })
    const agent = await ctx.agentLoop.create(SessionId('failover-candidate-elapsed'), primary)
    const resolveModel = target.resolveModel.bind(target)
    vi.spyOn(target, 'resolveModel').mockImplementation((provider, model) => {
      vi.setSystemTime(100)
      return resolveModel(provider, model)
    })
    await send(agent)
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/failover-exhausted')).toBe(true)
  })

  it('stops recovery once the elapsed request budget has expired', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    async function* elapsedFailure(): AsyncGenerator<StreamChunk> {
      vi.setSystemTime(100)
      throw new LlmError('still busy after budget', 'SERVER')
    }
    const source = new RouteAdapter([new LlmError('busy', 'SERVER'), elapsedFailure()])
    const target = new RouteAdapter([])
    const ctx = await harness(source, target, { sameRouteRetries: 1, maxElapsedMs: 100 })
    const agent = await ctx.agentLoop.create(SessionId('failover-elapsed-budget'), primary)
    const scheduled = new Promise<void>((resolve) => {
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'llm/failover-attempt') resolve()
      })
    })
    const idle = send(agent)
    await scheduled
    await vi.runAllTimersAsync()
    await idle
    expect(source.requests).toHaveLength(2)
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/failover-exhausted')).toHaveLength(1)
  })

  it('cancels a pending same-route delay without dispatching another route', async () => {
    vi.useFakeTimers()
    const source = new RouteAdapter([new LlmError('busy', 'SERVER')])
    const target = new RouteAdapter([])
    const ctx = await harness(source, target, { sameRouteRetries: 1, retryDelayMs: 500 })
    const agent = await ctx.agentLoop.create(SessionId('failover-cancel'), primary)
    const scheduled = new Promise<void>((resolve) => {
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'llm/failover-attempt') resolve()
      })
    })
    const idle = send(agent)
    await scheduled
    agent.cancel({ kind: 'user' })
    await idle
    await vi.runAllTimersAsync()
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/failover')).toBe(false)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  })

  it('removes failover listeners and settles the retry wait when its plugin is disposed', async () => {
    const source = new RouteAdapter([new LlmError('busy', 'SERVER'), new LlmError('quota after unload', 'QUOTA')])
    const target = new RouteAdapter([])
    const ctx = await harness(source, target, { sameRouteRetries: 1, retryDelayMs: 500 })
    const retryFiber = policyFiber!
    const agent = await ctx.agentLoop.create(SessionId('failover-dispose'), primary)
    const scheduled = new Promise<void>((resolve) => {
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'llm/failover-attempt') resolve()
      })
    })
    const idle = send(agent)
    await scheduled
    await retryFiber.dispose()
    await idle
    await send(agent)
    expect(source.requests).toHaveLength(2)
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/failover-attempt')).toHaveLength(1)
  })

  it.each(['recovery', 'selection'] as const)('cancels and drains pending route metadata during %s plugin disposal', async (phase) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')])
    const target = new RouteAdapter(phase === 'selection' ? [response('backup')] : [])
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId(`failover-pending-${phase}`), primary)
    if (phase === 'selection') {
      await send(agent)
      vi.setSystemTime(1_000)
    }
    let entered!: () => void
    const pending = new Promise<void>((resolve) => { entered = resolve })
    let observedSignal: AbortSignal | undefined
    const metadata = phase === 'recovery' ? target : source
    vi.spyOn(metadata, 'resolveModel').mockImplementation((_provider, _model, signal) => {
      observedSignal = signal
      entered()
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(new DOMException('metadata cancelled', 'AbortError'))
        else signal?.addEventListener('abort', () => { reject(new DOMException('metadata cancelled', 'AbortError')) }, { once: true })
      })
    })
    const idle = send(agent)
    await pending
    await policyFiber!.dispose()
    await idle
    expect(observedSignal?.aborted).toBe(true)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(phase === 'selection' ? 1 : 0)
  })

  it('keeps fallback sticky until cooldown expires and then probes the primary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA'), response('primary recovered')])
    const target = new RouteAdapter([response('first backup'), response('sticky backup')])
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId('failover-cooldown'), primary)
    await send(agent)
    await send(agent)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(2)
    expectReply(agent, 'sticky backup')

    vi.setSystemTime(new Date('2026-01-01T00:00:01Z'))
    await send(agent)
    expect(source.requests).toHaveLength(2)
    expect(target.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/failover')).toMatchObject([
      { data: { reason: 'failure', from: primary, to: backup } },
      { data: { reason: 'cooldown-expired', from: backup, to: primary } },
    ])
    expectReply(agent, 'primary recovered')
  })

  it.each([false, true])('only restores a smaller primary after actual history repricing (meter mounted: %s)', async (withMeter) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA'), response('restored primary')], {
      context: { contextWindow: 100_000 }, defaultMaxTokens: 1_024,
    })
    const target = new RouteAdapter([response('backup'), response('remain on backup')], { context: { contextWindow: 200_000 } })
    const ctx = await harness(source, target)
    if (withMeter) await ctx.plugin(TokenMeter)
    const agent = await ctx.agentLoop.create(SessionId(`failover-downsize-${withMeter}`), primary)
    await send(agent)
    vi.setSystemTime(1_000)
    await send(agent)
    expect(source.requests).toHaveLength(withMeter ? 2 : 1)
    expect(target.requests).toHaveLength(withMeter ? 1 : 2)
    expectReply(agent, withMeter ? 'restored primary' : 'remain on backup')
  })

  it('keeps the larger fallback when actual history exceeds primary capacity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')])
    const target = new RouteAdapter([response('x'.repeat(600_000)), response('stay on larger backup')], { context: { contextWindow: 200_000 } })
    vi.spyOn(source, 'resolveModel').mockImplementation((provider, model) => Promise.resolve({
      provider, id: model, name: model, context: { contextWindow: 100_000 }, defaultMaxTokens: 1_024,
    }))
    const ctx = await harness(source, target)
    await ctx.plugin(TokenMeter)
    const agent = await ctx.agentLoop.create(SessionId('failover-downsize-too-large'), primary)
    await send(agent)
    vi.setSystemTime(1_000)
    await send(agent)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(2)
    expectReply(agent, 'stay on larger backup')
  })

  it('refuses primary restoration when UTF-8 history exceeds capacity despite a low token estimate', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')], {
      context: { contextWindow: 100_000 }, defaultMaxTokens: 1_024,
    })
    const target = new RouteAdapter([response('漢'.repeat(40_000)), response('remain on larger backup')], {
      context: { contextWindow: 200_000 },
    })
    const ctx = await harness(source, target)
    await ctx.plugin(TokenMeter)
    const agent = await ctx.agentLoop.create(SessionId('failover-downsize-multibyte'), primary)
    await send(agent)
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeLessThan(100_000)
    vi.setSystemTime(1_000)
    await send(agent)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(2)
    expectReply(agent, 'remain on larger backup')
  })

  it('refuses primary dispatch when route-dependent prompt assembly exceeds the restored capacity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')], {
      context: { contextWindow: 100_000 }, defaultMaxTokens: 1_024,
    })
    const target = new RouteAdapter([response('backup answered')], { context: { contextWindow: 200_000 } })
    const ctx = await harness(source, target)
    await ctx.plugin(TokenMeter)
    const agent = await ctx.agentLoop.create(SessionId('failover-prepared-expansion'), primary)
    await send(agent)
    ctx.systemPrompt.section({
      name: 'route-dependent-guidance', order: 0, complete: true,
      text: assembled => assembled.modelSelection?.provider === 'alpha' ? '漢'.repeat(40_000) : 'backup guidance',
    })
    vi.setSystemTime(1_000)
    await send(agent)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'FAILOVER_INCOMPATIBLE' } } },
    })
  })

  it('keeps the known working backup when the cooldown probe cannot resolve the primary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')])
    const target = new RouteAdapter([response('first backup'), response('backup after failed probe'), response('sticky after failed probe')])
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId('failover-unavailable-probe'), primary)
    await send(agent)
    const resolve = vi.spyOn(source, 'resolveModel').mockRejectedValue(new LlmError('primary unavailable', 'MODEL_UNAVAILABLE'))
    vi.setSystemTime(1_000)
    await send(agent)
    expectReply(agent, 'backup after failed probe')
    const probes = resolve.mock.calls.length
    await send(agent)
    expect(resolve).toHaveBeenCalledTimes(probes)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(3)
    expectReply(agent, 'sticky after failed probe')
  })

  it('rejects oversized target prompt assembly even when target context capacity equals the primary', async () => {
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')])
    const target = new RouteAdapter([])
    const ctx = await harness(source, target)
    await ctx.plugin(TokenMeter)
    ctx.systemPrompt.section({
      name: 'expanded-target-guidance', order: 0, complete: true,
      text: assembled => assembled.modelSelection?.provider === 'beta' ? '漢'.repeat(40_000) : 'small primary prompt',
    })
    const agent = await ctx.agentLoop.create(SessionId('failover-equal-context-expansion'), primary)
    await send(agent)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'FAILOVER_INCOMPATIBLE' } } },
    })
  })

  it('does not resurrect stale failover state after a manual choice during metadata resolution', async () => {
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')])
    const target = new RouteAdapter([])
    const manual = new RouteAdapter([response('manual model answered')])
    const ctx = await harness(source, target)
    ctx.llm.registerAdapter(['gamma'], manual)
    const agent = await ctx.agentLoop.create(SessionId('failover-manual-during-metadata'), primary)
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let release!: (info: LlmResolvedModelInfo) => void
    vi.spyOn(target, 'resolveModel').mockImplementationOnce((_provider, _model, signal) => {
      entered()
      return new Promise((resolve, reject) => {
        release = resolve
        signal?.addEventListener('abort', () => { reject(new DOMException('metadata cancelled', 'AbortError')) }, { once: true })
      })
    })
    const idle = send(agent)
    await started
    agent.model.select({ provider: 'gamma', model: 'manual' })
    release({ provider: 'beta', id: 'backup', name: 'backup', context: { contextWindow: 100_000 }, defaultMaxTokens: 1_024 })
    await idle
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'FAILOVER_SUPERSEDED' } } },
    })
    await send(agent)
    expect(manual.requests).toHaveLength(1)
    expectReply(agent, 'manual model answered')
  })

  it('does not confuse an adapter-defaulted reasoning effort with a manual selection', async () => {
    const high = ReasoningEffortId('high')
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')], {
      context: { contextWindow: 100_000 }, reasoning: { efforts: [{ id: high, name: 'High' }], defaultEffort: high },
    })
    const target = new RouteAdapter([response('backup after defaulted reasoning')])
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId('failover-defaulted-reasoning'), primary)
    await send(agent)
    expect(source.requests[0]?.reasoningEffort).toBe(high)
    expect(target.requests).toHaveLength(1)
    expect(target.requests[0]?.reasoningEffort).toBeUndefined()
    expectReply(agent, 'backup after defaulted reasoning')
  })

  it('preserves a same-route manual effort change made while the primary request is streaming', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    async function* blockedFailure(): AsyncGenerator<StreamChunk> {
      entered()
      await released
      throw new LlmError('quota after manual choice', 'QUOTA')
    }
    const high = ReasoningEffortId('high')
    const source = new RouteAdapter([blockedFailure(), response('manual effort retained')], {
      context: { contextWindow: 100_000 }, reasoning: { efforts: [{ id: high, name: 'High' }] },
    })
    const target = new RouteAdapter([])
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId('failover-manual-effort-during-stream'), primary)
    const idle = send(agent)
    await started
    agent.model.select({ ...primary, reasoningEffort: high })
    release()
    await idle
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'FAILOVER_SUPERSEDED' } } },
    })
    await send(agent)
    expect(source.requests[1]?.reasoningEffort).toBe(high)
    expectReply(agent, 'manual effort retained')
  })

  it('preserves a manual effort change made during pre-step before the step is recorded', async () => {
    const high = ReasoningEffortId('high')
    const source = new RouteAdapter([new LlmError('quota after pre-step', 'QUOTA'), response('pre-step manual effort retained')], {
      context: { contextWindow: 100_000 }, reasoning: { efforts: [{ id: high, name: 'High' }] },
    })
    const target = new RouteAdapter([])
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId('failover-manual-effort-during-pre-step'), primary)
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const stopBlocking = ctx.on('agent/pre-step', async (_payload, next) => {
      entered()
      await released
      return next()
    })
    const idle = send(agent)
    await started
    expect(agent.session.snapshotEvents().some(event => event.type === 'step/start')).toBe(false)
    agent.model.select({ ...primary, reasoningEffort: high })
    stopBlocking()
    release()
    await idle
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'FAILOVER_SUPERSEDED' } } },
    })
    await send(agent)
    expect(source.requests[1]?.reasoningEffort).toBe(high)
    expectReply(agent, 'pre-step manual effort retained')
  })

  it('honors manual primary selection before the cooldown deadline', async () => {
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA'), response('manual primary')])
    const target = new RouteAdapter([response('backup')])
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId('failover-manual'), primary)
    await send(agent)
    agent.model.select(primary)
    await send(agent)
    expect(source.requests).toHaveLength(2)
    expect(target.requests).toHaveLength(1)
    expectReply(agent, 'manual primary')
  })

  it('keeps the existing no-retry behavior when failover is disabled', async () => {
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')])
    const target = new RouteAdapter([])
    const ctx = await harness(source, target, { enabled: false })
    const agent = await ctx.agentLoop.create(SessionId('failover-kill-switch'), primary)
    await send(agent)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type.startsWith('llm/failover'))).toBe(false)
  })

  it('never executes tool calls emitted by the failed primary attempt', async () => {
    const source = new RouteAdapter([partialTool()])
    const target = new RouteAdapter([response('safe backup')])
    const ctx = await harness(source, target)
    const execute = vi.fn(async () => [{ type: 'text' as const, text: 'side effect' }])
    ctx.tools.register(defineContentToolFixture({ name: 'danger', description: 'effectful operation', parameters: {}, execute }))
    const agent = await ctx.agentLoop.create(SessionId('failover-partial-tool'), primary)
    await send(agent)
    expect(execute).not.toHaveBeenCalled()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/call')).toBe(false)
    expect(JSON.stringify(target.requests[0]?.messages)).not.toContain('uncommitted-failover-call')
    expectReply(agent, 'safe backup')
  })

  it.each([
    ['smaller', { context: { contextWindow: 50_000 } }],
    ['unknown', {}],
  ] as const)('skips a target with %s context capacity', async (_label, metadata) => {
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')])
    const target = new RouteAdapter([], metadata)
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId(`failover-context-${_label}`), primary)
    await send(agent)
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/failover-exhausted')).toBe(true)
  })

  it('rejects a text-only fallback when retained history contains an image', async () => {
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')])
    const target = new RouteAdapter([], { context: { contextWindow: 100_000 }, inputModalities: ['text'] })
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId('failover-image-history'), primary)
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'image', attachment: {
        attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
      } }],
      source: { kind: 'user' },
    }))
    await idle
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/failover-exhausted')).toMatchObject([{
      data: { attempted: [{ selection: primary, code: 'QUOTA' }, { selection: backup, code: 'UNSUPPORTED_IMAGE_INPUT' }] },
    }])
  })

  it('allows a text-only fallback when retained history contains no images', async () => {
    const source = new RouteAdapter([new LlmError('quota', 'QUOTA')])
    const target = new RouteAdapter([response('text backup')], { context: { contextWindow: 100_000 }, inputModalities: ['text'] })
    const ctx = await harness(source, target)
    const agent = await ctx.agentLoop.create(SessionId('failover-text-history'), primary)
    await send(agent)
    expect(target.requests).toHaveLength(1)
    expectReply(agent, 'text backup')
  })
})
