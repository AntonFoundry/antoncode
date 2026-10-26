/**
 * The pool walk: discovery over availability, per-model capacity facts, ranked
 * failover with cooldowns, the pinned and empty-pool refusals, and the rule
 * that output already delivered is never retried.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { LlmError, resolveRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '@deepseek-ai/dsh-llm-openai'
import {
  AUTO_MODEL,
  AUTO_MODEL_NAME,
  emptyState,
  VazhiAdapter,
  type PoolDocument,
  type RouterState,
  type VazhiEndpoint,
  type VazhiResolvedOptions,
  type VazhiRouter,
} from '@deepseek-ai/dsh-llm-vazhi'

const HELLO_EVENTS = [
  JSON.stringify({ choices: [{ delta: { role: 'assistant', content: null } }] }),
  JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
  '[DONE]',
]

function sse(...events: string[]): Response {
  return new Response(events.map(event => `data: ${event}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function pool(models: Array<{ model: string; meta?: PoolDocument['pool'][number]['meta'] }>): PoolDocument {
  return { version: 1, generated: '2026-10-24T00:00:00.000Z', sharedLimits: [], pool: models }
}

function connection(overrides: Partial<VazhiResolvedOptions> = {}): VazhiResolvedOptions {
  return {
    directory: '/nonexistent',
    displayName: 'Vazhi',
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    streamIdleTimeoutMs: 30_000,
    maxAttempts: 3,
    slowStartMs: 15_000,
    slowForMs: 600_000,
    retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0, retryableCodes: ['RATE_LIMIT'] }, 'test'),
    ...overrides,
  }
}

function endpoint(baseURL: string, model: string): VazhiEndpoint {
  return { baseURL, model, headers: {} }
}

interface Harness {
  readonly adapter: VazhiAdapter
  readonly router: VazhiRouter & {
    readonly loadPool: ReturnType<typeof vi.fn>
    readonly loadState: ReturnType<typeof vi.fn>
    readonly availableUpstreams: ReturnType<typeof vi.fn>
    readonly endpointOf: ReturnType<typeof vi.fn>
    readonly penalize: ReturnType<typeof vi.fn>
    readonly recover: ReturnType<typeof vi.fn>
    readonly noteStart: ReturnType<typeof vi.fn>
  }
  readonly fetchMock: ReturnType<typeof vi.fn>
}

/** A router over `document` whose endpoints default to one per provider. */
function harness(options: {
  document?: PoolDocument
  state?: RouterState
  available?: readonly string[]
  endpoints?: (model: string) => VazhiEndpoint | undefined
  connection?: Partial<VazhiResolvedOptions>
  fetch?: (url: string) => Response
} = {}): Harness {
  const document = options.document ?? pool([{ model: 'ovh/One' }])
  const fetchMock = vi.fn(async (input: unknown) => (options.fetch ?? (() => sse(...HELLO_EVENTS)))(String(input)))
  vi.stubGlobal('fetch', fetchMock)
  const router = {
    loadPool: vi.fn(async () => document),
    loadState: vi.fn(async () => options.state ?? emptyState()),
    availableUpstreams: vi.fn(async () => new Set(options.available ?? ['ovh', 'llm7'])),
    endpointOf: vi.fn(async (model: string) => options.endpoints === undefined
      ? endpoint(`https://${model.split('/')[0]}.test/v1`, model.split('/')[1]!)
      : options.endpoints(model)),
    penalize: vi.fn(async () => {}),
    recover: vi.fn(async () => {}),
    noteStart: vi.fn(async () => {}),
  }
  const resolved = connection(options.connection)
  const adapter = new VazhiAdapter({
    options: () => resolved,
    router,
    resolveUserId: () => 'anonymous' as AnonymousUserId,
  })
  return { adapter, router, fetchMock }
}

/** Drive one stream to completion, collecting text. */
async function text(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let out = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') out += chunk.text
  }
  return out
}

async function failure(stream: AsyncIterable<StreamChunk>): Promise<LlmError> {
  try {
    for await (const _chunk of stream) {
      // Drain until the failure surfaces.
    }
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError)
    return error as LlmError
  }
  throw new Error('expected the stream to fail')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('route identity', () => {
  it('reports the configured label and retry policy', () => {
    const { adapter } = harness()
    expect(adapter.providerInfo('vazhi')).toEqual({ id: 'vazhi', name: 'Vazhi' })
    expect(adapter.providerRetryPolicy('vazhi')).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })
})

describe('listModels', () => {
  it('puts auto first, then admitted models whose upstream can serve', async () => {
    const { adapter } = harness({
      document: pool([
        { model: 'ovh/One', meta: { id: 'One', name: 'One (OVH)' } },
        { model: 'nvidia/Two' },
        { model: 'llm7/Three' },
      ]),
      available: ['ovh', 'llm7'],
    })
    await expect(adapter.listModels('vazhi')).resolves.toEqual([
      { provider: 'vazhi', id: AUTO_MODEL, name: AUTO_MODEL_NAME, inputModalities: ['text'] },
      { provider: 'vazhi', id: 'ovh/One', name: 'One (OVH)', inputModalities: ['text'] },
      { provider: 'vazhi', id: 'llm7/Three', name: 'llm7/Three', inputModalities: ['text'] },
    ])
  })

  it('lists only auto when nothing can serve', async () => {
    const { adapter } = harness({ available: [] })
    await expect(adapter.listModels('vazhi')).resolves.toEqual([
      { provider: 'vazhi', id: AUTO_MODEL, name: AUTO_MODEL_NAME, inputModalities: ['text'] },
    ])
  })
})

describe('resolveModel', () => {
  it('adds pool capacity and label facts to an admitted model', async () => {
    const { adapter } = harness({
      document: pool([{ model: 'ovh/One', meta: { id: 'One', name: 'One (OVH)', contextWindow: 32_000, maxTokens: 4_096 } }]),
    })
    await expect(adapter.resolveModel('vazhi', 'ovh/One')).resolves.toEqual({
      provider: 'vazhi',
      id: 'ovh/One',
      name: 'One (OVH)',
      inputModalities: ['text'],
      context: { contextWindow: 32_000 },
      defaultMaxTokens: 4_096,
    })
  })

  it('names auto and falls back to the route defaults', async () => {
    const { adapter } = harness()
    await expect(adapter.resolveModel('vazhi', AUTO_MODEL)).resolves.toEqual({
      provider: 'vazhi',
      id: AUTO_MODEL,
      name: AUTO_MODEL_NAME,
      inputModalities: ['text'],
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    })
    await expect(adapter.resolveModel('vazhi', 'ovh/Unknown')).resolves.toEqual({
      provider: 'vazhi',
      id: 'ovh/Unknown',
      name: 'ovh/Unknown',
      inputModalities: ['text'],
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    })
  })
})

describe('stream over the pool', () => {
  it('walks to the next free model after a failure and records both outcomes', async () => {
    const { adapter, router, fetchMock } = harness({
      document: pool([{ model: 'ovh/One' }, { model: 'llm7/Two' }]),
      fetch: url => url.startsWith('https://ovh.test')
        ? new Response('{"error":{"message":"boom"}}', { status: 500 })
        : sse(...HELLO_EVENTS),
    })
    await expect(text(adapter.stream({ provider: 'vazhi', model: AUTO_MODEL, messages: [] }))).resolves.toBe('hello')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(router.penalize).toHaveBeenCalledWith('ovh/One', expect.stringContaining('SERVER'))
    expect(router.penalize).toHaveBeenCalledWith('ovh/One', expect.stringContaining('boom'))
    expect(router.recover).toHaveBeenCalledWith('llm7/Two', expect.any(Number))
    expect(router.noteStart).toHaveBeenCalledWith('llm7/Two', expect.any(Number))
  })

  it('records the recovery without a start mark when no content arrived', async () => {
    const onlyFinish = [
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 0 } }),
      '[DONE]',
    ]
    const { adapter, router } = harness({ fetch: () => sse(...onlyFinish) })
    await expect(text(adapter.stream({ provider: 'vazhi', model: AUTO_MODEL, messages: [] }))).resolves.toBe('')
    expect(router.recover).toHaveBeenCalledWith('ovh/One', expect.any(Number))
    expect(router.noteStart).not.toHaveBeenCalled()
  })

  it('surfaces a pinned model failure instead of falling through', async () => {
    const { adapter, router, fetchMock } = harness({
      document: pool([{ model: 'ovh/One' }, { model: 'llm7/Two' }]),
      fetch: () => new Response('{"error":{"message":"boom"}}', { status: 500 }),
    })
    await expect(failure(adapter.stream({ provider: 'vazhi', model: 'ovh/One', messages: [] })))
      .resolves.toMatchObject({ code: 'SERVER' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(router.penalize).toHaveBeenCalledWith('ovh/One', expect.stringContaining('SERVER'))
    expect(router.recover).not.toHaveBeenCalled()
  })

  it('refuses an empty pool', async () => {
    const { adapter } = harness({ document: pool([]) })
    await expect(failure(adapter.stream({ provider: 'vazhi', model: AUTO_MODEL, messages: [] })))
      .resolves.toMatchObject({ code: 'POOL_EMPTY', message: 'llm-vazhi: the free-model pool is empty' })
  })

  it('reports the wait when every pool model is cooling down', async () => {
    const state = emptyState()
    state.models['ovh/One'] = { until: Date.now() + 90_000, failures: 1, reason: 'rate', at: Date.now() }
    const { adapter } = harness({ state })
    const error = await failure(adapter.stream({ provider: 'vazhi', model: AUTO_MODEL, messages: [] }))
    expect(error.code).toBe('RATE_LIMIT')
    expect(error.message).toContain('every free model is cooling down')
    expect(error.message).toContain('the next one frees up in 2m')
  })

  it('warns a pinned selection that it is cooling down', async () => {
    const state = emptyState()
    state.models['ovh/One'] = { until: Date.now() + 90_000, failures: 1, reason: 'rate', at: Date.now() }
    const pinned = harness({ state, document: pool([{ model: 'ovh/One' }]) })
    const error = await failure(pinned.adapter.stream({ provider: 'vazhi', model: 'ovh/One', messages: [] }))
    expect(error.code).toBe('RATE_LIMIT')
    expect(error.message).toContain('pinned model ovh/One is cooling down')
    expect(error.message).toContain('2m')
  })

  it('skips an unreachable upstream without spending an attempt', async () => {
    const { adapter, router } = harness({
      document: pool([{ model: 'nvidia/One' }, { model: 'ovh/Two' }]),
      endpoints: model => model === 'nvidia/One' ? undefined : endpoint('https://ovh.test/v1', 'Two'),
    })
    await expect(text(adapter.stream({ provider: 'vazhi', model: AUTO_MODEL, messages: [] }))).resolves.toBe('hello')
    expect(router.penalize).not.toHaveBeenCalled()
  })

  it('refuses when no pool model has a reachable upstream', async () => {
    const { adapter, router } = harness({
      document: pool([{ model: 'nvidia/One' }, { model: 'openrouter/Two' }]),
      endpoints: () => undefined,
    })
    await expect(failure(adapter.stream({ provider: 'vazhi', model: AUTO_MODEL, messages: [] })))
      .resolves.toMatchObject({ code: 'POOL_EMPTY', message: 'llm-vazhi: no free model is available' })
    expect(router.penalize).not.toHaveBeenCalled()
  })

  it('names the pinned model when its upstream cannot serve', async () => {
    const { adapter } = harness({ endpoints: () => undefined })
    const error = await failure(adapter.stream({ provider: 'vazhi', model: 'ovh/One', messages: [] }))
    expect(error.code).toBe('MISSING_CREDENTIAL')
    expect(error.message).toContain('ovh/One is not available')
  })

  it('stops walking once output reached the consumer', async () => {
    const encoder = new TextEncoder()
    let delivered = false
    const flaky = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${HELLO_EVENTS[1]}\n\n`))
      },
      pull(controller) {
        // The queued chunk is consumed before this runs, so the consumer has
        // already seen partial output when the socket dies.
        delivered = true
        controller.error(new Error('socket closed'))
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const { adapter, router, fetchMock } = harness({
      document: pool([{ model: 'ovh/One' }, { model: 'llm7/Two' }]),
      fetch: () => flaky,
    })
    const error = await failure(adapter.stream({ provider: 'vazhi', model: AUTO_MODEL, messages: [] }))
    expect(delivered).toBe(true)
    expect(error).toBeInstanceOf(LlmError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(router.penalize).not.toHaveBeenCalled()
  })

  it('does not cool a model down when the caller aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { adapter, router, fetchMock } = harness({
      fetch: () => {
        throw new Error('aborted by caller')
      },
    })
    await expect(failure(adapter.stream({
      provider: 'vazhi',
      model: AUTO_MODEL,
      messages: [],
      signal: controller.signal,
    }))).resolves.toBeInstanceOf(LlmError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(router.penalize).not.toHaveBeenCalled()
  })

  it('reports exhaustion after the configured attempt budget', async () => {
    const { adapter, router, fetchMock } = harness({
      document: pool([{ model: 'ovh/One' }]),
      connection: { maxAttempts: 2 },
      fetch: () => new Response('{"error":{"message":"boom"}}', { status: 500 }),
    })
    const error = await failure(adapter.stream({ provider: 'vazhi', model: AUTO_MODEL, messages: [] }))
    expect(error.code).toBe('PROVIDER_EXHAUSTED')
    expect(error.message).toContain('after 2 attempt(s)')
    expect(error.message).toContain('ovh/One:')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(router.penalize).toHaveBeenCalledTimes(2)
  })
})
