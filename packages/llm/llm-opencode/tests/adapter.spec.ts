/**
 * Stream-flow tests for the opencode server adapter against a stateful
 * in-process mock of the server API: transient generation, session recovery,
 * and transport failures. Pure value mappings live in `mapping.spec.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  ReasoningEffortId,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as LlmOpenCode from '@deepseek-ai/dsh-llm-opencode'
import {
  OpenCodeServerAdapter,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-opencode'
import { closeMockServers, mockOpenCodeServer, type MockOpenCodeServerOptions } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
})

function userText(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function adapterOf(
  serverURL: string,
  // Untyped like the sibling harness helpers: only known-good literals flow in.
  config: object = {},
  transport: () => Promise<{ url: string; headers: Record<string, string> }> = () =>
    Promise.resolve({ url: serverURL, headers: {} }),
): OpenCodeServerAdapter {
  return new OpenCodeServerAdapter({
    options: () =>
      resolveAdapterOptions({
        serverURL,
        requestTimeoutMs: 2_000,
        directory: '/tmp/test',
        ...config,
      }),
    transport,
  })
}

function streamOptions(model: string, messages: Message[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'opencode-free', model, messages, ...extra }
}

async function collect(adapter: OpenCodeServerAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

async function collectError(
  adapter: OpenCodeServerAdapter,
  options: GenerateOptions,
): Promise<{ code: string; message: string }> {
  try {
    await collect(adapter, options)
  } catch (error: unknown) {
    return {
      code: (error as { code?: string }).code ?? 'NO_CODE',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  throw new Error('stream unexpectedly succeeded')
}

describe('OpenCodeServerAdapter happy paths', () => {
  it('streams a text turn end to end with server attribution', async () => {
    const server = await mockOpenCodeServer({ assistant: { text: 'pong', tokens: { input: 10, output: 3 } } })
    const adapter = adapterOf(server.url)
    const chunks = await collect(adapter, streamOptions('fledge-alpha-free', [userText('ping?')]))

    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'pong' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })

    const create = server.requests.find(entry => entry.path === '/api/session')
    expect(create?.body).toMatchObject({
      model: { id: 'fledge-alpha-free', providerID: 'opencode' },
      location: { directory: '/tmp/test' },
    })
    const generate = server.requests.find(entry => entry.path.endsWith('/generate'))
    expect(generate?.body).toEqual({ prompt: 'User: ping?' })
    expect(server.requests.some(entry => entry.path.endsWith('/prompt'))).toBe(false)
    // Mandatory harness attribution rides every provider request.
    for (const entry of server.requests) {
      expect(entry.headers['user-agent']).toMatch(/^deepseek-harness\//)
    }
  })

  it('serves bare envelopes like released servers', async () => {
    const server = await mockOpenCodeServer({ envelope: false })
    const adapter = adapterOf(server.url)
    const chunks = await collect(adapter, streamOptions('fledge-alpha-free', [userText('ping?')]))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('resolves unknown model ids through the free-tier provider convention', async () => {
    const server = await mockOpenCodeServer()
    await collect(adapterOf(server.url), streamOptions('mystery-free', [userText('ping?')]))
    const create = server.requests.find(entry => entry.path === '/api/session')
    expect(create?.body).toMatchObject({ model: { id: 'mystery-free', providerID: 'opencode' } })
  })

  it('admits the selected effort as the server variant', async () => {
    const server = await mockOpenCodeServer({
      models: [{ modelID: 'v-free', providerID: 'opencode', variants: [{ id: 'low' }, { id: 'high' }] }],
    })
    const chunks = await collect(
      adapterOf(server.url),
      streamOptions('v-free', [userText('ping?')], { reasoningEffort: ReasoningEffortId('high') }),
    )
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const create = server.requests.find(entry => entry.path === '/api/session')
    expect(create?.body).toMatchObject({ model: { id: 'v-free', providerID: 'opencode', variant: 'high' } })
  })

  it('omits the variant for the off effort', async () => {
    const server = await mockOpenCodeServer({
      models: [{ modelID: 'v-free', providerID: 'opencode', variants: [{ id: 'low' }, { id: 'high' }] }],
    })
    await collect(
      adapterOf(server.url),
      streamOptions('v-free', [userText('ping?')], { reasoningEffort: ReasoningEffortId('off') }),
    )
    const create = server.requests.find(entry => entry.path === '/api/session')
    const model = (create?.body as { model?: Record<string, unknown> } | undefined)?.model
    expect(model).toMatchObject({ id: 'v-free', providerID: 'opencode' })
    expect(model).not.toHaveProperty('variant')
  })

  it('rejects efforts no variant advertises before touching the server', async () => {
    const server = await mockOpenCodeServer({
      models: [{ modelID: 'v-free', providerID: 'opencode', variants: [{ id: 'low' }] }],
    })
    const failure = await collectError(
      adapterOf(server.url),
      streamOptions('v-free', [userText('ping?')], { reasoningEffort: ReasoningEffortId('ultra') }),
    )
    expect(failure.code).toBe('INVALID_REQUEST')
    expect(failure.message).toMatch(/ultra/)
    expect(server.sessions).toHaveLength(0)
  })
})

describe('OpenCodeServerAdapter sessions', () => {
  it('opens one server session per call without a harness session', async () => {
    const server = await mockOpenCodeServer()
    const adapter = adapterOf(server.url)
    await collect(adapter, streamOptions('fledge-alpha-free', [userText('one')]))
    await collect(adapter, streamOptions('fledge-alpha-free', [userText('two')]))
    expect(server.sessions).toHaveLength(2)
  })

  it('reuses one server session per harness session', async () => {
    const server = await mockOpenCodeServer()
    const adapter = adapterOf(server.url)
    const sessionId = SessionId('conv-1')
    await collect(adapter, streamOptions('fledge-alpha-free', [userText('first?')], { sessionId }))
    await collect(
      adapter,
      streamOptions('fledge-alpha-free', [userText('first?'), userText('second?')], { sessionId }),
    )
    expect(server.sessions).toHaveLength(1)
    const generates = server.requests.filter(entry => entry.path.endsWith('/generate'))
    expect(generates).toHaveLength(2)
    expect(generates[1]?.body).toEqual({ prompt: 'User: first?\n\nUser: second?' })
  })

  it('opens a fresh session when the model changes mid-conversation', async () => {
    const server = await mockOpenCodeServer()
    const adapter = adapterOf(server.url)
    const sessionId = SessionId('conv-2')
    await collect(adapter, streamOptions('fledge-alpha-free', [userText('first?')], { sessionId }))
    await collect(adapter, streamOptions('mystery-free', [userText('first?'), userText('second?')], { sessionId }))
    expect(server.sessions).toHaveLength(2)
  })

  it('opens a fresh session when the effort changes mid-conversation', async () => {
    const server = await mockOpenCodeServer({
      models: [{ modelID: 'v-free', providerID: 'opencode', variants: [{ id: 'low' }, { id: 'high' }] }],
    })
    const adapter = adapterOf(server.url)
    const sessionId = SessionId('conv-effort')
    await collect(
      adapter,
      streamOptions('v-free', [userText('first?')], { sessionId, reasoningEffort: ReasoningEffortId('high') }),
    )
    await collect(
      adapter,
      streamOptions('v-free', [userText('first?'), userText('second?')], {
        sessionId,
        reasoningEffort: ReasoningEffortId('high'),
      }),
    )
    await collect(
      adapter,
      streamOptions('v-free', [userText('first?'), userText('second?'), userText('third?')], {
        sessionId,
        reasoningEffort: ReasoningEffortId('low'),
      }),
    )
    expect(server.sessions).toHaveLength(2)
    const creates = server.requests.filter(entry => entry.path === '/api/session')
    expect(creates[1]?.body).toMatchObject({ model: { id: 'v-free', variant: 'low' } })
  })

  it('recreates a stale session and regenerates the complete transcript there', async () => {
    const server = await mockOpenCodeServer()
    const adapter = adapterOf(server.url)
    const sessionId = SessionId('conv-4')
    await collect(adapter, streamOptions('fledge-alpha-free', [userText('first?')], { sessionId }))
    server.expire(server.sessions[0]!)
    const chunks = await collect(
      adapter,
      streamOptions('fledge-alpha-free', [userText('first?'), userText('second?')], { sessionId }),
    )
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.sessions).toHaveLength(2)
    const generates = server.requests.filter(entry => entry.path.endsWith('/generate'))
    expect(generates.at(-1)?.body).toEqual({ prompt: 'User: first?\n\nUser: second?' })
  })

  it('rejects an empty generation without polling', async () => {
    const server = await mockOpenCodeServer({ generate: 'empty' })
    const failure = await collectError(adapterOf(server.url), streamOptions('fledge-alpha-free', [userText('hi')]))
    expect(failure.code).toBe('EMPTY_RESPONSE')
    expect(server.requests.some(entry => entry.path.endsWith('/prompt'))).toBe(false)
  })

  it('maps generation failures to SERVER', async () => {
    const server = await mockOpenCodeServer({ generate: 'error' })
    const failure = await collectError(adapterOf(server.url), streamOptions('fledge-alpha-free', [userText('hi')]))
    expect(failure.code).toBe('SERVER')
  })

  it('recovers an ephemeral stale session without tracking it', async () => {
    const server = await mockOpenCodeServer({ staleFirstGenerate: true })
    const adapter = adapterOf(server.url)
    const chunks = await collect(adapter, streamOptions('fledge-alpha-free', [userText('second?')]))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.sessions).toHaveLength(2)
  })

  it('rejects servers without transient generation without invoking their agent loop', async () => {
    const server = await mockOpenCodeServer({ generate: 'unavailable' })
    const failure = await collectError(adapterOf(server.url), streamOptions('fledge-alpha-free', [userText('hi')]))
    expect(failure.code).toBe('SERVER')
    expect(failure.message).toMatch(/transient generation/)
    expect(server.requests.filter(entry => entry.path.endsWith('/generate'))).toHaveLength(2)
    expect(server.requests.some(entry => entry.path.endsWith('/prompt'))).toBe(false)
  })
})

describe('OpenCodeServerAdapter failures', () => {
  it('offers tools through text while leaving execution to the Harness', async () => {
    const server = await mockOpenCodeServer({ assistant: { text: 'pong', tokens: { input: 10, output: 3 } } })
    const chunks = await collect(
      adapterOf(server.url),
      streamOptions('fledge-alpha-free', [userText('hi')], {
        tools: [{ name: 'search', description: 'search', parameters: { type: 'object' } }],
      }),
    )
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const generate = server.requests.find(entry => entry.path.endsWith('/generate'))
    expect(generate?.body).toHaveProperty('prompt', expect.stringContaining('Available tools:\n- search: search'))
    expect(server.requests.some(entry => entry.path.endsWith('/prompt'))).toBe(false)
  })

  it('returns fenced calls as Harness tool blocks and a tool-calls finish', async () => {
    const server = await mockOpenCodeServer({ assistant: { text: '```tool\n{"name":"search","arguments":{"query":"hello"}}\n```' } })
    const chunks = await collect(adapterOf(server.url), streamOptions('fledge-alpha-free', [userText('search')], {
      tools: [{ name: 'search', description: 'Search', parameters: { type: 'object' } }],
    }))
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    if (call?.type !== 'block-end' || call.block.type !== 'tool-call') throw new Error('Missing tool call')
    expect(call.block.id).toMatch(/^call_opencode_/)
    expect(call.block).toEqual({ type: 'tool-call', id: call.block.id, name: 'search', arguments: '{"query":"hello"}' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('rejects image history instead of dropping attachments silently', async () => {
    const server = await mockOpenCodeServer()
    const message = createUserMessage({
      content: [{ type: 'text', text: 'describe' }],
      source: { kind: 'user' },
    })
    const withImage = { ...message, content: [...message.content, { type: 'image', attachment: { id: 'a' } }] }
    const failure = await collectError(
      adapterOf(server.url),
      streamOptions('fledge-alpha-free', [withImage as unknown as Message]),
    )
    expect(failure.code).toBe('INVALID_REQUEST')
  })

  it('maps wrong credentials to AUTH', async () => {
    const server = await mockOpenCodeServer({ requireAuth: true })
    const failure = await collectError(adapterOf(server.url), streamOptions('fledge-alpha-free', [userText('hi')]))
    expect(failure.code).toBe('AUTH')
  })

  it('maps rate limiting to RATE_LIMIT', async () => {
    const server = await mockOpenCodeServer({ modelsStatus: 429 })
    const adapter = adapterOf(server.url)
    await expect(adapter.listModels('opencode-free')).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('maps unexpected model-listing statuses verbatim', async () => {
    const server = await mockOpenCodeServer({ modelsStatus: 403 })
    await expect(adapterOf(server.url).listModels('opencode-free')).rejects.toMatchObject({ code: 'HTTP_403' })
  })

  it('maps session-creation failures to SERVER', async () => {
    const server = await mockOpenCodeServer({ createStatus: 500 })
    const failure = await collectError(adapterOf(server.url), streamOptions('fledge-alpha-free', [userText('hi')]))
    expect(failure.code).toBe('SERVER')
  })

  it('rejects sessions created with an empty id', async () => {
    const server = await mockOpenCodeServer({ createEmptyId: true })
    const failure = await collectError(adapterOf(server.url), streamOptions('fledge-alpha-free', [userText('hi')]))
    expect(failure.code).toBe('SERVER')
    expect(failure.message).toMatch(/without an id/)
  })

  it('rejects sessions created without an id', async () => {
    const server = await mockOpenCodeServer({ createWithoutId: true })
    const failure = await collectError(adapterOf(server.url), streamOptions('fledge-alpha-free', [userText('hi')]))
    expect(failure.code).toBe('SERVER')
    expect(failure.message).toMatch(/without an id/)
  })

  it('aborts before any session on an already-aborted signal', async () => {
    const server = await mockOpenCodeServer()
    const failure = await collectError(
      adapterOf(server.url),
      streamOptions('fledge-alpha-free', [userText('hi')], { signal: AbortSignal.abort() }),
    )
    expect(failure.code).toBe('ABORTED')
    expect(server.sessions).toHaveLength(0)
  })

  it('reports an unreachable server as TRANSPORT with recovery guidance', async () => {
    const adapter = adapterOf('http://127.0.0.1:1')
    const failure = await collectError(adapter, streamOptions('fledge-alpha-free', [userText('hi')]))
    expect(failure.code).toBe('TRANSPORT')
    expect(failure.message).toMatch(/opencode service start/)
  })

  it('rethinks nothing: a defective transport surfaces its own failure', async () => {
    const adapter = new OpenCodeServerAdapter({
      options: () => resolveAdapterOptions({ requestTimeoutMs: 500, directory: '/tmp' }),
      transport: () => Promise.reject(new Error('no server configured')),
    })
    await expect(collect(adapter, streamOptions('fledge-alpha-free', [userText('hi')]))).rejects.toThrow(
      'no server configured',
    )
  })
})

describe('OpenCodeServerAdapter discovery', () => {
  const PAID_MODELS: MockOpenCodeServerOptions['models'] = [
    { id: 'pro-model', providerID: 'opencode', name: 'Pro', cost: [{ input: 1, output: 2 }] },
    { id: 'free-model', providerID: 'opencode', name: 'Free', cost: { input: 0, output: 0 }, limit: { context: 50 } },
  ]

  it('lists only zero-cost models with their display names', async () => {
    const server = await mockOpenCodeServer({ models: PAID_MODELS })
    expect(await adapterOf(server.url).listModels('opencode-free')).toEqual([
      { provider: 'opencode-free', id: 'free-model', name: 'Free' },
    ])
  })

  it('dedupes repeated model ids, keeping the server-preferred entry', async () => {
    const server = await mockOpenCodeServer({
      models: [
        { modelID: 'dup-free', providerID: 'opencode', name: 'First' },
        { modelID: 'dup-free', providerID: 'opencode', name: 'Second' },
      ],
    })
    expect(await adapterOf(server.url).listModels('opencode-free')).toEqual([
      { provider: 'opencode-free', id: 'dup-free', name: 'First' },
    ])
  })

  it('serves an empty picker from an unreachable server and recovers later', async () => {
    const adapter = adapterOf('http://127.0.0.1:1')
    expect(await adapter.listModels('opencode-free')).toEqual([])
  })

  it('serves an empty picker from an empty model body', async () => {
    const server = await mockOpenCodeServer({ modelsEmptyBody: true })
    expect(await adapterOf(server.url).listModels('opencode-free')).toEqual([])
  })

  it('resolves known models from the cached listing', async () => {
    const server = await mockOpenCodeServer({ models: PAID_MODELS })
    const adapter = adapterOf(server.url)
    const resolved = await adapter.resolveModel('opencode-free', 'free-model')
    expect(resolved).toMatchObject({ name: 'Free', context: { contextWindow: 50 }, defaultMaxTokens: 16_384 })
    const again = await adapter.resolveModel('opencode-free', 'free-model')
    expect(again.name).toBe('Free')
    expect(server.requests.filter(entry => entry.path === '/api/model')).toHaveLength(1)
  })

  it('exposes server variants as selectable efforts with no pinned default', async () => {
    const server = await mockOpenCodeServer({
      models: [{ modelID: 'v-free', providerID: 'opencode', name: 'V', variants: [{ id: 'low' }, { id: 'high' }] }],
    })
    const resolved = await adapterOf(server.url).resolveModel('opencode-free', 'v-free')
    expect(resolved.reasoning).toEqual({
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
      ],
    })
  })

  it('omits reasoning metadata for variant-free models', async () => {
    const server = await mockOpenCodeServer()
    const resolved = await adapterOf(server.url).resolveModel('opencode-free', 'fledge-alpha-free')
    expect(resolved.reasoning).toBeUndefined()
  })

  it('resolves unlisted models to defaults without rejecting them', async () => {
    const server = await mockOpenCodeServer({ models: PAID_MODELS })
    const resolved = await adapterOf(server.url).resolveModel('opencode-free', 'ghost-free')
    expect(resolved).toMatchObject({ name: 'ghost-free', context: { contextWindow: 128_000 } })
  })

  it('reports provider identity and retry policy from connection facts', async () => {
    const server = await mockOpenCodeServer()
    const adapter = adapterOf(server.url)
    expect(adapter.providerInfo('opencode-free')).toEqual({ id: 'opencode-free', name: 'OpenCode Free' })
    expect(adapter.providerRetryPolicy('opencode-free')).toEqual(resolveAdapterOptions({}).retryPolicy)
  })
})

describe('OpenCodeServerAdapter through the runtime', () => {
  it('registers the opencode route and streams through ctx.llm', async () => {
    const server = await mockOpenCodeServer({ assistant: { text: 'pong', tokens: { input: 10, output: 3 } } })
    const ctx = new Context()
    const resolveCredential = vi.fn(() => { throw new Error('Service mode must not resolve direct credentials') })
    ctx.provide('credentials', { resolve: resolveCredential } as never)
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmOpenCode, {
      transport: 'service',
      agent: 'anton-harness',
      serverURL: server.url,
      requestTimeoutMs: 2_000,
      directory: '/tmp/test',
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'opencode-free', name: 'OpenCode Free' }])
    expect(resolveCredential).not.toHaveBeenCalled()
    const kinds: string[] = []
    for await (
      const chunk of ctx.llm.stream({
        provider: 'opencode-free',
        model: 'fledge-alpha-free',
        messages: [userText('ping?')],
      })
    ) {
      kinds.push(chunk.type)
    }
    expect(kinds).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(server.requests.find(entry => entry.path === '/api/session')?.body).toHaveProperty('agent', 'anton-harness')
    await fiber.dispose()
  })
})
