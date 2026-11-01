/**
 * Direct-Zen transport tests for the `opencode-free` route: Zen client
 * headers, keyed/anonymous transport selection, catalog discovery, effort
 * serialization, tool-call round trips, error mapping, and cancellation —
 * all against scripted in-process gateways, no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ReasoningEffortId,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ModelsDevAdapter, ModelsDevCatalog } from '@deepseek-ai/dsh-llm-models-dev'
import type { ModelsDevConnectionOptions } from '@deepseek-ai/dsh-llm-models-dev'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import * as LlmOpenCode from '@deepseek-ai/dsh-llm-opencode'
import {
  OpenCodeRouterAdapter,
  OpenCodeServerAdapter,
  resolveAdapterOptions,
  resolveRealKey,
  resolveZenApiKey,
  resolveZenHeaders,
} from '@deepseek-ai/dsh-llm-opencode'
import { resolveServerTransport } from '@deepseek-ai/dsh-llm-opencode'
import { mockZenGateway } from './mock-zen.ts'
import { closeMockServers, mockOpenCodeServer } from './mock-server.ts'

const servers: Server[] = []
const homes: string[] = []
const zens: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
  await Promise.all(zens.splice(0).map(zen => zen.close().catch(() => {})))
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const FREE_CATALOG = {
  opencode: {
    models: {
      'chat-free': {
        name: 'Chat Free',
        cost: { input: 0, output: 0 },
        modalities: { input: ['text'] },
        limit: { context: 4096 },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'xhigh'] }],
      },
      'spark-free': {
        name: 'Spark Free',
        cost: { input: 0, output: 0 },
        modalities: { input: ['text', 'image'] },
        limit: { context: 8192 },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'max'] }],
        provider: { npm: '@ai-sdk/openai' },
      },
      'legacy-free': {
        name: 'Legacy Free',
        status: 'deprecated',
        cost: { input: 0, output: 0 },
        modalities: { input: ['text'] },
      },
      'paid-pro': {
        name: 'Paid Pro',
        cost: { input: 1, output: 2 },
        modalities: { input: ['text'] },
      },
      'opencode/auto': {
        name: 'Router',
        cost: { input: 0, output: 0 },
        modalities: { input: ['text'] },
      },
      'image-only-free': {
        name: 'Image Only',
        cost: { input: 0, output: 0 },
        modalities: { input: ['image'] },
      },
    },
  },
}

/** Serve the free-tier catalog document at `/api.json`. */
async function mockCatalog(document: unknown = FREE_CATALOG): Promise<string> {
  const server = createServer((_request, response) => {
    const body = JSON.stringify(document)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('catalog mock has no address')
  return `http://127.0.0.1:${String(address.port)}`
}

function userText(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function streamOptions(model: string, messages: Message[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'opencode-free', model, messages, ...extra }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function collectError(stream: AsyncIterable<StreamChunk>): Promise<{ code: string; message: string }> {
  try {
    await collect(stream)
  } catch (error: unknown) {
    return {
      code: (error as { code?: string }).code ?? 'NO_CODE',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  throw new Error('stream unexpectedly succeeded')
}

interface Harness {
  router: OpenCodeRouterAdapter
  zenURL: string
  zen: { requests: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: unknown }[] }
}

/** Build the router over a scripted Zen gateway, catalog, and service mock. */
async function harness(options: {
  key?: string
  keyed: boolean
  zen?: Parameters<typeof mockZenGateway>[0]
  service?: Parameters<typeof mockOpenCodeServer>[0] | 'down'
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-opencode-zen-'))
  homes.push(dir)
  vi.stubEnv('DSH_HOME', dir)
  const zen = await mockZenGateway(options.zen ?? {})
  zens.push(zen)
  const catalogURL = await mockCatalog()
  const catalog = new ModelsDevCatalog(catalogURL, 60_000)
  // Warm the snapshot so protocol routing sees the catalog before the first
  // request, exactly like the plugin's mount-time refresh does in production.
  await catalog.freeModels('opencode')
  const connection: ModelsDevConnectionOptions = {
    apiKeyEnv: credentialRef('OPENCODE_TEST_KEY'),
    baseURL: zen.url,
    displayName: 'OpenCode Free',
    defaults: {},
    maxTokens: 16_384,
    defaultContextWindow: 128_000,
    models: [],
    streamIdleTimeoutMs: 300_000,
    retryPolicy: resolveAdapterOptions({}).retryPolicy,
    catalogProvider: 'opencode',
  }
  const direct = new ModelsDevAdapter({
    options: () => connection,
    resolveApiKey: async () => options.key ?? 'public',
    resolveUserId: () => getOrCreateAnonymousUserId(),
    catalog,
    extraHeaders: (_provider, _connection, sessionId, requestId) =>
      resolveZenHeaders(sessionId, requestId),
    modelProtocol: (_provider, model) => catalog
      .peekProtocol('opencode', model) === 'responses'
      ? 'responses'
      : 'chat-completions',
  })
  const serviceURL = options.service === undefined
    ? (await mockOpenCodeServer()).url
    : options.service === 'down'
      ? 'http://127.0.0.1:1'
      : (await mockOpenCodeServer(options.service)).url
  const serviceOptions = resolveAdapterOptions({
    serverURL: serviceURL,
    autoStart: false,
    requestTimeoutMs: 2_000,
    directory: '/tmp/test',
  })
  const service = new OpenCodeServerAdapter({
    options: () => serviceOptions,
    transport: () => resolveServerTransport(serviceOptions),
  })
  // Route the transport decision through the production key probe so its
  // credential-service, environment, and absent-key branches all execute.
  const credentials = options.key === undefined
    ? undefined
    : { resolve: async () => ({ value: options.key as string }) }
  const keyed = async (): Promise<boolean> =>
    (await resolveRealKey(credentialRef('OPENCODE_TEST_KEY'), credentials)) !== undefined
  const router = new OpenCodeRouterAdapter({
    service,
    direct,
    resolveTransport: async () => (await keyed())
      ? { adapter: direct, freeTier: false, via: 'keyed' as const }
      : { adapter: service, freeTier: false, via: 'service' as const },
  })
  return { router, zenURL: zen.url, zen }
}

describe('resolveZenHeaders', () => {
  it('stamps the OpenCode client identity with real session and request ids', () => {
    const headers = resolveZenHeaders('ses_abc', 'msg_def')
    expect(headers).toMatchObject({
      'x-opencode-session-id': 'ses_abc',
      'x-opencode-session': 'ses_abc',
      'x-opencode-request': 'msg_def',
      'x-opencode-client': 'cli',
      'user-agent': 'opencode/harness',
    })
  })

  it('falls back per process for the session and per call for the request', () => {
    const first = resolveZenHeaders(undefined)
    const second = resolveZenHeaders(undefined)
    expect(first['x-opencode-session']).toBe(second['x-opencode-session'])
    expect(first['x-opencode-request']).not.toBe(second['x-opencode-request'])
    expect(first['x-opencode-request']).toMatch(/^msg_/)
  })

  it('honors the OPENCODE_CLIENT environment override', () => {
    vi.stubEnv('OPENCODE_CLIENT', 'tui')
    expect(resolveZenHeaders('s', 'r')['x-opencode-client']).toBe('tui')
  })
})

describe('resolveZenApiKey', () => {
  it('returns the stored key, else the anonymous literal', async () => {
    const ref = credentialRef('OPENCODE_TEST_KEY')
    await expect(resolveZenApiKey(ref, { resolve: async () => ({ value: 'k1' }) })).resolves.toBe('k1')
    await expect(resolveZenApiKey(ref, undefined)).resolves.toBe('public')
  })

  it('rejects unusable stored values instead of sending them', async () => {
    await expect(resolveZenApiKey(
      credentialRef('OPENCODE_TEST_KEY'),
      { resolve: async () => ({ value: '  ' }) },
    )).rejects.toThrow()
  })

  it('falls back to anonymous when the service stores nothing for the reference', async () => {
    await expect(resolveZenApiKey(
      credentialRef('OPENCODE_TEST_KEY'),
      { resolve: async () => undefined },
    )).resolves.toBe('public')
  })

  it('falls back to the default credential reference when the connection names none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-opencode-zen-fallback-'))
    homes.push(dir)
    vi.stubEnv('DSH_HOME', dir)
    vi.stubEnv('OPENCODE_API_KEY', 'default-key')
    const zen = await mockZenGateway({ expectBearer: 'default-key' })
    zens.push(zen)
    const catalogURL = await mockCatalog()
    const catalog = new ModelsDevCatalog(catalogURL, 60_000)
    await catalog.freeModels('opencode')
    const { apiKeyEnv: _absent, ...stripped } = {
      apiKeyEnv: credentialRef('OPENCODE_TEST_KEY'),
      baseURL: zen.url,
      displayName: 'OpenCode Free',
      defaults: {},
      maxTokens: 16_384,
      defaultContextWindow: 128_000,
      models: [],
      streamIdleTimeoutMs: 300_000,
      retryPolicy: resolveAdapterOptions({}).retryPolicy,
      catalogProvider: 'opencode',
    } satisfies ModelsDevConnectionOptions
    expect(_absent).toBeDefined()
    const direct = new ModelsDevAdapter({
      options: () => stripped,
      resolveApiKey: async (_provider, connection) =>
        resolveZenApiKey(connection.apiKeyEnv ?? credentialRef('OPENCODE_API_KEY'), undefined),
      resolveUserId: () => getOrCreateAnonymousUserId(),
      catalog,
    })
    const chunks = await collect(direct.stream(streamOptions('chat-free', [userText('hi')])))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(zen.requests).toHaveLength(1)
    expect(zen.requests[0]!.headers.authorization).toBe('Bearer default-key')
  })
})

describe('router transport selection', () => {
  it('keyed requests ride direct Zen with the bearer key and Zen headers', async () => {
    const { router, zen } = await harness({ key: 'test-key', keyed: true })
    const message = userText('ping?')
    const chunks = await collect(router.stream(streamOptions('chat-free', [message], {
      sessionId: SessionId('ses_test1'),
      tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
      reasoningEffort: ReasoningEffortId('high'),
    })))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })

    expect(zen.requests).toHaveLength(1)
    const entry = zen.requests[0]!
    expect(entry.path).toBe('/chat/completions')
    expect(entry.headers.authorization).toBe('Bearer test-key')
    expect(entry.headers['x-opencode-session']).toBe('ses_test1')
    expect(entry.headers['x-opencode-session-id']).toBe('ses_test1')
    expect(entry.headers['x-opencode-request']).toBe(message.id)
    expect(entry.headers['x-opencode-client']).toBe('cli')
    expect(String(entry.headers['user-agent'])).toMatch(/^opencode\/harness deepseek-harness\//)
    const body = entry.body as Record<string, unknown>
    expect(body).toMatchObject({ model: 'chat-free', reasoning_effort: 'high' })
    expect(body.tools).toEqual([{
      type: 'function',
      function: { name: 'bash', description: 'run', parameters: { type: 'object' } },
    }])
  })

  it('anonymous requests ride the local service, never the gateway', async () => {
    const { router, zen } = await harness({ keyed: false })
    const chunks = await collect(router.stream(streamOptions('fledge-alpha-free', [userText('ping?')])))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(zen.requests).toHaveLength(0)
  })

  it('anonymous requests without a service surface the gateway verdict, not a transport error', async () => {
    const { router } = await harness({
      keyed: false,
      service: 'down',
      zen: { status: { '/chat/completions': 403 } },
    })
    const failure = await collectError(router.stream(streamOptions('chat-free', [userText('ping?')])))
    expect(failure.code).toBe('AUTH')
    expect(failure.message).toContain('status 403')
  })

  it('keyed discovery lists the catalog free tier; anonymous discovery lists the service', async () => {
    const keyed = await harness({ key: 'test-key', keyed: true })
    expect((await keyed.router.listModels('opencode-free')).map(model => model.id).sort()).toEqual([
      'chat-free',
      'legacy-free',
      'spark-free',
    ])
    const anonymous = await harness({ keyed: false })
    expect((await anonymous.router.listModels('opencode-free')).map(model => model.id))
      .toContain('fledge-alpha-free')
  })

  it('keyed model facts carry catalog efforts verbatim with no forced default', async () => {
    const { router } = await harness({ key: 'test-key', keyed: true })
    const info = await router.resolveModel('opencode-free', 'chat-free')
    expect(info.reasoning?.efforts.map(effort => String(effort.id)).sort())
      .toEqual(['high', 'low', 'xhigh'])
    expect(info.reasoning?.defaultEffort).toBeUndefined()
    expect(info.context?.contextWindow).toBe(4096)
  })

  it('reports the route facts and propagates non-transport service failures', async () => {
    const { router } = await harness({ keyed: false, service: { generate: 'error' } })
    expect(router.providerInfo('opencode-free')).toEqual({ id: 'opencode-free', name: 'OpenCode Free' })
    expect(router.providerRetryPolicy('opencode-free')).toMatchObject({ mode: 'normal' })
    // A 500 from the service is a server verdict, not a missing service:
    // the router must not mask it with an anonymous direct attempt.
    const failure = await collectError(router.stream(streamOptions('fledge-alpha-free', [userText('hi')])))
    expect(failure.code).toBe('SERVER')
  })
})

describe('direct effort and protocol routing', () => {
  it('passes catalog effort values onto the chat wire, including xhigh', async () => {
    const { router, zen } = await harness({ key: 'k', keyed: true })
    await collect(router.stream(streamOptions('chat-free', [userText('hi')], {
      reasoningEffort: ReasoningEffortId('xhigh'),
    })))
    expect((zen.requests[0]!.body as Record<string, unknown>).reasoning_effort).toBe('xhigh')
  })

  it('routes catalog Responses models to /responses with reasoning.effort', async () => {
    const { router, zen } = await harness({ key: 'k', keyed: true })
    const chunks = await collect(router.stream(streamOptions('spark-free', [userText('hi')], {
      reasoningEffort: ReasoningEffortId('max'),
    })))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(zen.requests).toHaveLength(1)
    expect(zen.requests[0]!.path).toBe('/responses')
    expect(zen.requests[0]!.body).toMatchObject({ model: 'spark-free', reasoning: { effort: 'high' } })
  })

  it('converts chat tool calls into harness chunks and serializes tool results back', async () => {
    const { router, zen } = await harness({
      key: 'k',
      keyed: true,
      zen: { chat: { text: [], toolCall: { id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' } } },
    })
    const tools = [{ name: 'bash', description: 'run', parameters: { type: 'object' } }]
    const chunks = await collect(router.stream(streamOptions('chat-free', [userText('list')], { tools })))
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })

    const followup = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'bash', arguments: '{"command":"ls"}' }],
      source: { provider: 'test', model: 'test' },
    })
    const result = createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'text', text: 'a.ts' }],
      isError: false,
    })
    await collect(router.stream(streamOptions('chat-free', [userText('list'), followup, result], { tools })))
    const second = zen.requests[1]!.body as Record<string, unknown>
    const messages = second.messages as Array<Record<string, unknown>>
    expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1' })
  })

  it('converts Responses function calls and serializes their outputs', async () => {
    const { router, zen } = await harness({
      key: 'k',
      keyed: true,
      zen: { responses: { text: [], toolCall: { callId: 'c9', name: 'bash', arguments: '{"command":"pwd"}' } } },
    })
    const tools = [{ name: 'bash', description: 'run', parameters: { type: 'object' } }]
    const chunks = await collect(router.stream(streamOptions('spark-free', [userText('where')], { tools })))
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'c9', name: 'bash', arguments: '{"command":"pwd"}' },
    })

    const followup = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('c9'), name: 'bash', arguments: '{"command":"pwd"}' }],
      source: { provider: 'test', model: 'test' },
    })
    const result = createToolResultMessage({
      callId: ToolCallId('c9'),
      content: [{ type: 'text', text: '/tmp' }],
      isError: false,
    })
    await collect(router.stream(streamOptions('spark-free', [userText('where'), followup, result], { tools })))
    const second = zen.requests[1]!.body as Record<string, unknown>
    const input = second.input as Array<Record<string, unknown>>
    expect(input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'c9' })
  })
})

describe('direct error mapping and cancellation', () => {
  it.each([
    ['/chat/completions', 401, 'AUTH'],
    ['/chat/completions', 429, 'RATE_LIMIT'],
    ['/chat/completions', 500, 'SERVER'],
  ])('maps %s status %s to %s', async (path, status, code) => {
    const { router } = await harness({ key: 'k', keyed: true, zen: { status: { [path]: status } } })
    const failure = await collectError(router.stream(streamOptions('chat-free', [userText('hi')])))
    expect(failure.code).toBe(code)
  })

  it('aborts mid-request on caller cancellation', async () => {
    const { router } = await harness({ key: 'k', keyed: true })
    const controller = new AbortController()
    controller.abort(new Error('user stopped'))
    const failure = await collectError(router.stream(streamOptions('chat-free', [userText('hi')], {
      signal: controller.signal,
    })))
    expect(failure.code).toBe('ABORTED')
  })
})

describe('mounted route composition', () => {
  it('registers opencode-free with catalog discovery through the plugin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-opencode-zen-'))
    homes.push(dir)
    vi.stubEnv('DSH_HOME', dir)
    vi.stubEnv('OPENCODE_TEST_KEY', 'test-key')
    const zen = await mockZenGateway()
    const catalogURL = await mockCatalog()
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmOpenCode, {
        zenBaseURL: zen.url,
        catalogURL,
        apiKeyEnv: 'OPENCODE_TEST_KEY',
        autoStart: false,
        serverURL: 'http://127.0.0.1:1',
      })
      const models = await ctx.llm.listModels('opencode-free')
      expect(models.map(model => model.id).sort()).toEqual(['chat-free', 'legacy-free', 'spark-free'])
      const info = await ctx.llm.resolveModelInfo('opencode-free', 'spark-free')
      expect(info.reasoning?.efforts.map(effort => String(effort.id)).sort()).toEqual(['low', 'max'])
    } finally {
      await ctx.fiber.dispose()
      await zen.close()
    }
  })

  it('streams keyed turns through the mounted direct transport', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-opencode-stream-'))
    homes.push(dir)
    vi.stubEnv('DSH_HOME', dir)
    vi.stubEnv('OPENCODE_TEST_KEY', 'test-key')
    const zen = await mockZenGateway({ expectBearer: 'test-key' })
    const catalogURL = await mockCatalog()
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmOpenCode, {
        zenBaseURL: zen.url,
        catalogURL,
        apiKeyEnv: 'OPENCODE_TEST_KEY',
        autoStart: false,
        serverURL: 'http://127.0.0.1:1',
      })
      const chunks: StreamChunk[] = []
      const message = userText('hi')
      for await (const chunk of ctx.llm.stream({
        provider: 'opencode-free',
        model: 'chat-free',
        messages: [message],
        sessionId: SessionId('ses_mounted1'),
      })) chunks.push(chunk)
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(zen.requests).toHaveLength(1)
      expect(zen.requests[0]!.headers.authorization).toBe('Bearer test-key')
      expect(zen.requests[0]!.headers['x-opencode-session']).toBe('ses_mounted1')
      expect(zen.requests[0]!.headers['x-opencode-request']).toBe(message.id)
    } finally {
      await ctx.fiber.dispose()
      await zen.close()
    }
  })

  it('streams a Responses turn through the mounted direct transport', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-opencode-responses-'))
    homes.push(dir)
    vi.stubEnv('DSH_HOME', dir)
    vi.stubEnv('OPENCODE_TEST_KEY', 'test-key')
    const zen = await mockZenGateway()
    const catalogURL = await mockCatalog()
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmOpenCode, {
        zenBaseURL: zen.url,
        catalogURL,
        apiKeyEnv: 'OPENCODE_TEST_KEY',
        autoStart: false,
        serverURL: 'http://127.0.0.1:1',
      })
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({
        provider: 'opencode-free',
        model: 'spark-free',
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
        } as never],
      })) chunks.push(chunk)
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(zen.requests).toHaveLength(1)
      expect(zen.requests[0]!.path).toBe('/responses')
    } finally {
      await ctx.fiber.dispose()
      await zen.close()
    }
  })

  it('resolves a stored key through the credentials service', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-opencode-creds-'))
    homes.push(dir)
    vi.stubEnv('DSH_HOME', dir)
    await writeFile(join(dir, '.credentials.yaml'), 'OPENCODE_TEST_KEY: stored-key\n', { mode: 0o600 })
    const zen = await mockZenGateway({ expectBearer: 'stored-key' })
    const catalogURL = await mockCatalog()
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(LlmOpenCode, {
        zenBaseURL: zen.url,
        catalogURL,
        apiKeyEnv: 'OPENCODE_TEST_KEY',
        autoStart: false,
        serverURL: 'http://127.0.0.1:1',
      })
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({
        provider: 'opencode-free',
        model: 'chat-free',
        messages: [userText('hi')],
      })) chunks.push(chunk)
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(zen.requests).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await zen.close()
    }
  })

  it('keeps serving the service tier across catalog refresh failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-opencode-refresh-'))
    homes.push(dir)
    vi.stubEnv('DSH_HOME', dir)
    const service = await mockOpenCodeServer()
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmOpenCode, {
        catalogURL: 'http://127.0.0.1:1',
        catalogRefreshMs: 20,
        autoStart: false,
        serverURL: service.url,
      })
      // The mount refresh and at least one interval tick fail against the
      // dead catalog endpoint; both report through the catalog error hook
      // instead of rejecting, and discovery still serves the service tier.
      await new Promise(resolve => setTimeout(resolve, 150))
      expect((await ctx.llm.listModels('opencode-free')).map(model => model.id))
        .toContain('fledge-alpha-free')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
