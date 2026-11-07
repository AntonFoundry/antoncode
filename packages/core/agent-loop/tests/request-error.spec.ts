import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, LlmResolvedModelInfo, PreparedAdapterCall, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function fail(message: string, code: string): () => never {
  return () => {
    throw new LlmError(message, code)
  }
}

describe('agent/request-error', () => {
  it('expires a reroute before target admission or metadata I/O', async () => {
    const primary = new MockAdapter([fail('busy', 'SERVER')])
    const fallback = new MockAdapter([textResponse('unused')])
    const ctx = await harness(primary)
    ctx.llm.registerAdapter(['fallback'], fallback)
    const agent = await ctx.agentLoop.create(SessionId('expired-reroute'), { provider: 'mock', model: 'primary' })
    let targetAdmissions = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'condition', description: 'Target admission observer.', parameters: {},
      execute: async () => [{ type: 'text', text: 'unused' }],
    }), { when: ({ modelSelection }) => { if (modelSelection.provider === 'fallback') targetAdmissions++; return false } })
    ctx.on('agent/request-error', async () => ({
      kind: 'retry-route', selection: { provider: 'fallback', model: 'secondary' }, expiresAt: Date.now() - 1,
    }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(targetAdmissions).toBe(0)
    expect(fallback.requests).toEqual([])
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { code: 'RECOVERY_EXPIRED' } } },
    })
    await ctx.fiber.dispose()
  })

  it('aborts cooperative target preparation under the recovery deadline without relabeling user cancellation', async () => {
    vi.useFakeTimers()
    const entered = Promise.withResolvers<undefined>()
    class PendingAdapter extends MockAdapter {
      override async prepareCall(_provider: string, _model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
        entered.resolve(undefined)
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        throw new Error('unreachable')
      }
    }
    const primary = new MockAdapter([fail('busy', 'SERVER')])
    const fallback = new PendingAdapter([textResponse('unused')])
    const ctx = await harness(primary)
    try {
      ctx.llm.registerAdapter(['fallback'], fallback)
      const agent = await ctx.agentLoop.create(SessionId('deadline-prepare'), { provider: 'mock', model: 'primary' })
      ctx.on('agent/request-error', async () => ({
        kind: 'retry-route', selection: { provider: 'fallback', model: 'secondary' }, expiresAt: Date.now() + 100,
      }))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await entered.promise
      await vi.advanceTimersByTimeAsync(100)
      await agent.whenIdle()
      expect(fallback.requests).toEqual([])
      expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
        data: { reason: { kind: 'error', error: { code: 'RECOVERY_EXPIRED' } } },
      })
    } finally {
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('retains a same-route recovery deadline across a later retry that omits it', async () => {
    vi.useFakeTimers()
    const entered = Promise.withResolvers<undefined>()
    const adapter = new MockAdapter([
      fail('first busy', 'SERVER'), fail('second busy', 'SERVER'), 'hang',
    ])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('deadline-same-route'), { provider: 'mock', model: 'primary' })
      let recoveries = 0
      ctx.on('agent/request-error', async () => {
        recoveries++
        if (recoveries === 1) return { kind: 'retry', expiresAt: Date.now() + 100 }
        return { kind: 'retry' }
      })
      ctx.on('agent/assistant-stream', ({ frame }) => {
        if (frame.type === 'chunk' && adapter.requests.length === 3) entered.resolve(undefined)
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await entered.promise
      await vi.advanceTimersByTimeAsync(100)
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(3)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toEqual([])
      expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/attempt')).toHaveLength(3)
      expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
        data: { reason: { kind: 'error', error: { code: 'RECOVERY_EXPIRED' } } },
      })
    } finally {
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('recovers an unavailable prepared model before committing input or inventing a stream attempt', async () => {
    class UnavailableAdapter extends MockAdapter {
      override resolveModel(): Promise<LlmResolvedModelInfo> {
        return Promise.reject(new LlmError('catalog model unavailable', 'MODEL_UNAVAILABLE'))
      }
    }
    const primary = new UnavailableAdapter([textResponse('unused')])
    const fallback = new MockAdapter([textResponse('done')])
    const ctx = await harness(primary)
    ctx.llm.registerAdapter(['fallback'], fallback)
    const agent = await ctx.agentLoop.create(SessionId('prepare-model-unavailable'), { provider: 'mock', model: 'missing' })
    let recoveries = 0
    ctx.on('agent/request-error', async ({ pendingMessages, retryPolicy, modelSelection, failure }) => {
      recoveries++
      expect(failure.code).toBe('MODEL_UNAVAILABLE')
      expect(modelSelection).toEqual({ provider: 'mock', model: 'missing' })
      expect(retryPolicy).toBeUndefined()
      expect(pendingMessages).toHaveLength(1)
      expect(Object.isFrozen(pendingMessages)).toBe(true)
      expect(pendingMessages[0]?.content).toEqual([{ type: 'text', text: 'accepted once' }])
      expect(agent.session.snapshotEvents().some(event => ['user/message', 'system/message', 'request/header', 'assistant/attempt'].includes(event.type))).toBe(false)
      return { kind: 'retry-route', selection: { provider: 'fallback', model: 'secondary' } }
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'accepted once' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(recoveries).toBe(1)
    expect(primary.requests).toEqual([])
    expect(fallback.requests).toHaveLength(1)
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'assistant/attempt')).toEqual([])
    expect(events.filter(event => event.type === 'request/header').map(event => event.data.header.config.provider)).toEqual(['fallback'])
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
    await ctx.fiber.dispose()
  })

  it.each(['AUTH', 'CONTEXT_WINDOW_EXCEEDED', 'INVALID_REQUEST'])('does not recover preparation failure %s', async (code) => {
    class RejectedAdapter extends MockAdapter {
      override resolveModel(): Promise<LlmResolvedModelInfo> {
        return Promise.reject(new LlmError('preparation rejected', code))
      }
    }
    const primary = new RejectedAdapter([textResponse('unused')])
    const ctx = await harness(primary)
    const agent = await ctx.agentLoop.create(SessionId(`prepare-${code}`), { provider: 'mock', model: 'primary' })
    let recoveries = 0
    ctx.on('agent/request-error', async () => { recoveries++; return { kind: 'retry' } })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(recoveries).toBe(0)
    expect(primary.requests).toEqual([])
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('does not offer middleware MODEL_UNAVAILABLE to preparation recovery', async () => {
    const primary = new MockAdapter([textResponse('unused')])
    const ctx = await harness(primary)
    const agent = await ctx.agentLoop.create(SessionId('middleware-unavailable'), { provider: 'mock', model: 'primary' })
    let recoveries = 0
    ctx.on('agent/request', () => { throw new LlmError('middleware unavailable', 'MODEL_UNAVAILABLE') })
    ctx.on('agent/request-error', async () => { recoveries++; return { kind: 'retry' } })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(recoveries).toBe(0)
    expect(primary.requests).toEqual([])
    await ctx.fiber.dispose()
  })

  it('selects the effective route before tools, prompts, and pre-step admission', async () => {
    const primary = new MockAdapter([textResponse('unused')])
    const fallback = new MockAdapter([textResponse('done')])
    const ctx = await harness(primary)
    ctx.llm.registerAdapter(['fallback'], fallback)
    const agent = await ctx.agentLoop.create(SessionId('effective-selection'), { provider: 'mock', model: 'primary' })
    const selections: string[] = []
    ctx.on('agent/model-selection', async ({ requestedSelection, messages }) => {
      expect(messages).toHaveLength(1)
      expect(messages[0]?.content).toEqual([{ type: 'text', text: 'go' }])
      expect(Object.isFrozen(messages)).toBe(true)
      expect(Object.isFrozen(messages[0])).toBe(true)
      expect(requestedSelection).toEqual({ provider: 'mock', model: 'primary' })
      expect(Object.isFrozen(requestedSelection)).toBe(true)
      return { provider: 'fallback', model: 'secondary' }
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'secondary_tool', description: 'Secondary route tool.', parameters: {},
      execute: async () => [{ type: 'text', text: 'unused' }],
    }), { when: ({ modelSelection }) => {
      selections.push(modelSelection.model)
      return modelSelection.provider === 'fallback'
    } })
    ctx.systemPrompt.section({
      name: 'route', order: 0, complete: true,
      text: context => `route:${context.modelSelection?.model}`,
    })
    ctx.on('agent/pre-step', ({ modelSelection }, next) => {
      expect(modelSelection).toEqual({ provider: 'fallback', model: 'secondary' })
      return next()
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(primary.requests).toEqual([])
    expect(selections).toEqual(['secondary'])
    expect(fallback.requests[0]?.tools?.map(tool => tool.name)).toEqual(['secondary_tool'])
    expect(fallback.requests[0]?.messages.find(message => message.role === 'system')?.content)
      .toEqual([{ type: 'text', text: 'route:secondary' }])
    expect(agent.session.requestHeader()?.config).toMatchObject({ provider: 'fallback', model: 'secondary' })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rebuilds target admission without repeating accepted input or executing a failed partial tool call', async () => {
    const partial = toolCallResponse('failed-call', 'primary_tool', {}, 'discarded partial')
    partial[partial.length - 1] = { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'overloaded' } } }
    const primary = new MockAdapter([partial], undefined, 100)
    const fallback = new MockAdapter([toolCallResponse('fallback-call', 'secondary_tool', {}), textResponse('done')], undefined, 200)
    const ctx = await harness(primary)
    ctx.llm.registerAdapter(['fallback'], fallback)
    const agent = await ctx.agentLoop.create(SessionId('route-retry'), { provider: 'mock', model: 'primary' })
    let admissions = 0
    let selections = 0
    let executions = 0
    ctx.on('agent/model-selection', (_payload, next) => { selections++; return next() })
    ctx.on('agent/pre-step', (_payload, next) => { admissions++; return next() })
    for (const [name, provider] of [['primary_tool', 'mock'], ['secondary_tool', 'fallback']] as const) {
      ctx.tools.register(defineContentToolFixture({
        name, description: 'Route-specific tool.', parameters: {},
        execute: async () => { executions++; return [{ type: 'text', text: 'executed' }] },
      }), { when: ({ modelSelection }) => modelSelection.provider === provider })
    }
    ctx.systemPrompt.section({
      name: 'route', order: 0, complete: true,
      text: context => `${context.modelSelection?.provider}:${ctx.tools.schemas(agent, context.toolSet).map(tool => tool.name).join(',')}`,
    })
    ctx.on('agent/request-error', async ({ provider, model, modelSelection }) => {
      expect({ provider, model, modelSelection }).toEqual({
        provider: 'mock', model: 'primary', modelSelection: { provider: 'mock', model: 'primary' },
      })
      return { kind: 'retry-route', selection: { provider: 'fallback', model: 'secondary' } }
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'accepted once' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(primary.requests).toHaveLength(1)
    expect(fallback.requests).toHaveLength(2)
    expect(executions).toBe(1)
    expect(admissions).toBe(2) // A second logical step follows the successful tool batch.
    expect(selections).toBe(2)
    expect(fallback.requests[0]?.maxTokens).toBe(200)
    expect(fallback.requests[0]?.tools?.map(tool => tool.name)).toEqual(['secondary_tool'])
    expect(fallback.requests[0]?.messages.find(message => message.role === 'system')?.content)
      .toEqual([{ type: 'text', text: 'fallback:secondary_tool' }])
    expect(fallback.requests[0]?.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(JSON.stringify(fallback.requests[0]?.messages)).not.toContain('discarded partial')
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.callId)).toEqual(['fallback-call'])
    expect(events.filter(event => event.type === 'request/header').map(event => event.data.header.config.provider))
      .toEqual(['mock', 'fallback'])
    expect(events.filter(event => event.type === 'assistant/message').map(event => event.data.message.source.provider))
      .toEqual(['fallback', 'fallback'])
    await ctx.fiber.dispose()
  })

  it('does not dispatch a reroute when cancellation occurs during target admission', async () => {
    const primary = new MockAdapter([fail('busy', 'SERVER')])
    const fallback = new MockAdapter([textResponse('unused')])
    const ctx = await harness(primary)
    ctx.llm.registerAdapter(['fallback'], fallback)
    const agent = await ctx.agentLoop.create(SessionId('route-admission-cancel'), { provider: 'mock', model: 'primary' })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<boolean>()
    ctx.tools.register(defineContentToolFixture({
      name: 'conditional', description: 'Wait for target admission.', parameters: {},
      execute: async () => [{ type: 'text', text: 'unused' }],
    }), { when: ({ modelSelection }) => {
      if (modelSelection.provider !== 'fallback') return false
      entered.resolve(undefined)
      return release.promise
    } })
    ctx.on('agent/request-error', async () => ({ kind: 'retry-route', selection: { provider: 'fallback', model: 'secondary' } }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await entered.promise
    agent.cancel({ kind: 'user' })
    release.resolve(true)
    await agent.whenIdle()
    expect(fallback.requests).toEqual([])
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    await ctx.fiber.dispose()
  })

  it('retains an explicit output cap instead of applying the fallback adapter default', async () => {
    const primary = new MockAdapter([fail('busy', 'SERVER')], undefined, 100)
    const fallback = new MockAdapter([textResponse('done')], undefined, 200)
    const ctx = await harness(primary)
    ctx.llm.registerAdapter(['fallback'], fallback)
    const agent = await ctx.agentLoop.create(SessionId('route-explicit-output'), { provider: 'mock', model: 'primary', maxTokens: 42 })
    ctx.on('agent/request-error', async () => ({ kind: 'retry-route', selection: { provider: 'fallback', model: 'secondary' } }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(primary.requests[0]?.maxTokens).toBe(42)
    expect(fallback.requests[0]?.maxTokens).toBe(42)
    expect(agent.session.requestHeader()?.adapterDefaults?.maxTokens).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rejects an unsupported target effort without dispatch or duplicated user input', async () => {
    const primary = new MockAdapter([fail('busy', 'SERVER')])
    const fallback = new MockAdapter([textResponse('unused')])
    const ctx = await harness(primary)
    ctx.llm.registerAdapter(['fallback'], fallback)
    const agent = await ctx.agentLoop.create(SessionId('route-effort-invalid'), { provider: 'mock', model: 'primary' })
    ctx.on('agent/request-error', async () => ({
      kind: 'retry-route', selection: { provider: 'fallback', model: 'secondary', reasoningEffort: ReasoningEffortId('high') },
    }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(fallback.requests).toEqual([])
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(events.find(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { code: 'UNSUPPORTED_REASONING_EFFORT' } } },
    })
    await ctx.fiber.dispose()
  })

  it('keeps target prompt failures terminal rather than dispatching the previous admission', async () => {
    const primary = new MockAdapter([fail('busy', 'SERVER')])
    const fallback = new MockAdapter([textResponse('unused')])
    const ctx = await harness(primary)
    ctx.llm.registerAdapter(['fallback'], fallback)
    const agent = await ctx.agentLoop.create(SessionId('route-assembly-failed'), { provider: 'mock', model: 'primary' })
    ctx.systemPrompt.section({
      name: 'route', order: 0, complete: true,
      text: (context) => {
        if (context.modelSelection?.provider === 'fallback') throw new Error('target prompt unavailable')
        return 'primary prompt'
      },
    })
    ctx.on('agent/request-error', async () => ({ kind: 'retry-route', selection: { provider: 'fallback', model: 'secondary' } }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(primary.requests).toHaveLength(1)
    expect(fallback.requests).toEqual([])
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { message: 'target prompt unavailable' } } },
    })
    await ctx.fiber.dispose()
  })

  it('does not admit a route selected after cancellation', async () => {
    const primary = new MockAdapter([textResponse('unused')])
    const ctx = await harness(primary)
    const agent = await ctx.agentLoop.create(SessionId('selection-cancel'), { provider: 'mock', model: 'primary' })
    let admissions = 0
    ctx.on('agent/model-selection', async ({ agent: subject }, next) => {
      subject.cancel({ kind: 'user' })
      return next()
    })
    ctx.on('agent/pre-step', (_payload, next) => { admissions++; return next() })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(primary.requests).toEqual([])
    expect(admissions).toBe(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('does not offer middleware failures to request recovery', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-narrow'), { provider: 'mock', model: 'mock' })
    let recoveries = 0
    ctx.on('agent/request', () => {
      throw new LlmError('middleware failed', 'MIDDLEWARE')
    })
    ctx.on('agent/request-error', async () => {
      recoveries += 1
      return undefined
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(recoveries).toBe(0)
    expect(adapter.requests).toHaveLength(0)
  })

  it('lets each failed request return a retry action before its turn closes', async () => {
    const adapter = new MockAdapter([
      fail('busy', 'RATE_LIMIT'),
      fail('unavailable', 'SERVICE_UNAVAILABLE'),
      textResponse('ok'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-retry'), { provider: 'mock', model: 'mock' })
    const seen: {
      turn: number
      step: number
      failure: LlmFailure
      retryPolicy: ResolvedRetryPolicy | undefined
    }[] = []
    const statuses: string[] = []
    ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent) statuses.push(status)
    })
    ctx.on('agent/request-error', async ({ agent: subject, turn, step, failure, retryPolicy }) => {
      expect(subject).toBe(agent)
      seen.push({ turn, step, failure, retryPolicy })
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(seen.map(item => ({
      turn: item.turn,
      step: item.step,
      code: item.failure.code,
    }))).toEqual([
      {
        turn: 1,
        step: 1,
        code: 'RATE_LIMIT',
      },
      {
        turn: 1,
        step: 1,
        code: 'SERVICE_UNAVAILABLE',
      },
    ])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(seen.map(item => item.retryPolicy)).toEqual([
      expect.objectContaining({ mode: 'normal' }),
      expect.objectContaining({ mode: 'normal' }),
    ])
    expect(statuses).toEqual(['running', 'idle'])
    expect(agent.session.snapshotEvents().flatMap(event =>
      event.type === 'request/header' ? [event.data.reason] : [])).toEqual(['initial'])
  })

  it('lets cancellation win over a retry action', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-cancel'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async ({ agent: subject }) => {
      subject.cancel({ kind: 'user' })
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
  })

  it('does not retry when the recovery listener fails before returning its action', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-recovery-failed'), {
      provider: 'mock',
      model: 'mock',
    })
    ctx.on('agent/request-error', async () => {
      throw new Error('recovery failed')
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error' } },
    })
  })
})
