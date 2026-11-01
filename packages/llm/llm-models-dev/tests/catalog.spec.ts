/**
 * Unit guards for the models.dev catalog client and the plugin's discovery
 * freshness wiring: the mount fetches every configured route eagerly, the
 * fiber-owned interval re-fetches, disposal stops it, and a failed refresh
 * keeps the last good snapshot instead of emptying the picker.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { ModelsDevCatalog, parseFreeModels, parseModelProtocols } from '@deepseek-ai/dsh-llm-models-dev'
import * as LlmModelsDev from '@deepseek-ai/dsh-llm-models-dev'

const FREE_MODEL = {
  name: 'Test Free',
  cost: { input: 0, output: 0 },
  modalities: { input: ['text'] },
  limit: { context: 4096 },
}

interface CatalogPayload {
  opencode: { models: Record<string, unknown> }
}

function payload(models: Record<string, unknown> = { 'test-free': FREE_MODEL }): CatalogPayload {
  return { opencode: { models } }
}

const okFetchOf = (body: () => unknown): ReturnType<typeof vi.fn> =>
  vi.fn(async () => ({ ok: true, json: async () => body() }))

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Poll an eventually-true assertion instead of sleeping a fixed guess. */
async function until(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error
      await sleep(5)
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('ModelsDevCatalog', () => {
  it('refresh() replaces a fresh snapshot; freeModels() then serves it without a fetch', async () => {
    const body = payload()
    const fetchMock = okFetchOf(() => body)
    vi.stubGlobal('fetch', fetchMock)
    const catalog = new ModelsDevCatalog('https://models.dev', 3_600_000)

    await catalog.freeModels('opencode')
    await catalog.freeModels('opencode')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    body.opencode.models = { 'test-free-v2': FREE_MODEL }
    await catalog.refresh('opencode')
    expect([...catalog.peekCached('opencode')!.keys()]).toEqual(['test-free-v2'])
    await expect(catalog.freeModels('opencode')).resolves.toBe(catalog.peekCached('opencode'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refresh() keeps the previous snapshot and reports instead of rejecting on failure', async () => {
    let healthy = true
    vi.stubGlobal('fetch', vi.fn(async () => healthy
      ? { ok: true, json: async () => payload() }
      : { ok: false, status: 503 }))
    const catalog = new ModelsDevCatalog('https://models.dev', 3_600_000)
    await catalog.freeModels('opencode')

    healthy = false
    const errors: unknown[] = []
    await expect(catalog.refresh('opencode', (error) => { errors.push(error) })).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect([...catalog.peekCached('opencode')!.keys()]).toEqual(['test-free'])
    // The stale snapshot keeps serving query-time discovery.
    await expect(catalog.freeModels('opencode')).resolves.toBe(catalog.peekCached('opencode'))
  })

  it('refresh() on a cold catalog resolves, reports, and leaves no snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    const catalog = new ModelsDevCatalog('https://models.dev', 3_600_000)
    const errors: unknown[] = []
    await expect(catalog.refresh('opencode', (error) => { errors.push(error) })).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(catalog.peekCached('opencode')).toBeUndefined()
  })

  it('freeModels() refetches once the configured TTL lapses', async () => {
    const fetchMock = okFetchOf(() => payload())
    vi.stubGlobal('fetch', fetchMock)
    const catalog = new ModelsDevCatalog('https://models.dev', 30)
    await catalog.freeModels('opencode')
    await catalog.freeModels('opencode')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await sleep(45)
    await catalog.freeModels('opencode')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('parseFreeModels', () => {
  it('keeps only zero-cost chat models under the provider namespace', () => {
    const models = parseFreeModels(payload({
      'free-text': FREE_MODEL,
      paid: { ...FREE_MODEL, cost: { input: 1, output: 2 } },
      'image-only': { ...FREE_MODEL, modalities: { input: ['image'] } },
      'opencode/meta': FREE_MODEL,
    }), 'opencode')
    expect([...models!.keys()]).toEqual(['free-text'])
  })

  it('requires a declared zero cost: a missing cost block is not free', () => {
    const models = parseFreeModels(payload({
      'explicit-free': FREE_MODEL,
      uncosted: { name: 'Uncosted', modalities: { input: ['text'] } },
    }), 'opencode')
    expect([...models!.keys()]).toEqual(['explicit-free'])
    expect(models!.get('explicit-free')?.reasoning).toBe(false)
  })

  it('matches OpenCode anonymous discovery by accepting zero-input-cost models', () => {
    const models = parseFreeModels(payload({
      'zero-input': { ...FREE_MODEL, cost: { input: 0, output: 1 } },
      'nonzero-input': { ...FREE_MODEL, cost: { input: 1, output: 0 } },
    }), 'opencode')
    expect([...models!.keys()]).toEqual(['zero-input'])
  })

  it('carries the catalog reasoning flag', () => {
    const models = parseFreeModels(payload({
      thinker: { ...FREE_MODEL, reasoning: true },
    }), 'opencode')
    expect(models!.get('thinker')?.reasoning).toBe(true)
  })

  it('keeps only advertised reasoning effort values', () => {
    const models = parseFreeModels(payload({
      thinker: {
        ...FREE_MODEL,
        reasoning: true,
        reasoning_options: [
          { type: 'toggle' },
          { type: 'effort', values: ['none', 'minimal', 'high', 'xhigh', 'max', 'invalid', 'high'] },
        ],
      },
    }), 'opencode')
    expect(models!.get('thinker')?.reasoningEfforts).toEqual(['none', 'minimal', 'high', 'xhigh', 'max'])
  })
})

describe('llm-models-dev mount freshness', () => {
  it('fetches the route at mount, refetches on the interval, and stops at disposal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-models-dev-'))
    vi.stubEnv('DSH_HOME', home)
    const fetchMock = okFetchOf(() => payload())
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    let disposed = false
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmModelsDev, {
        catalogRefreshMs: 25,
        providers: { 'opencode-free': { baseURL: 'https://opencode.ai/zen/v1' } },
      })

      // Eager mount fetch: discovery is warm before any picker query.
      await until(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
      await expect(ctx.llm.listModels('opencode-free')).resolves.toEqual([
        { provider: 'opencode-free', id: 'test-free', name: 'Test Free', inputModalities: ['text'] },
      ])
      // The fresh cache serves the query without a second fetch.
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // The background interval keeps re-fetching without consumer demand.
      await until(() => { expect(fetchMock).toHaveBeenCalledTimes(3) })

      await ctx.fiber.dispose()
      disposed = true
      await sleep(5)
      const countAtDispose = fetchMock.mock.calls.length
      await sleep(80)
      expect(fetchMock).toHaveBeenCalledTimes(countAtDispose)
    } finally {
      if (!disposed) await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('declared route credentials', () => {
  it('defaults OpenRouter Free to its saved free-tier credential reference', () => {
    expect(LlmModelsDev.resolveAdapterOptions({}, 'openrouter-free').apiKeyEnv)
      .toBe('OPENROUTER_FREE_API_KEY')
  })
})

describe('free-model reasoning metadata', () => {
  it('declares efforts only for reasoning models, with the gateway default', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-models-dev-reasoning-'))
    vi.stubEnv('DSH_HOME', home)
    vi.stubGlobal('fetch', okFetchOf(() => payload({
      'reason-free': {
        ...FREE_MODEL,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] }],
      },
      'chat-only': FREE_MODEL,
      'toggle-only': { ...FREE_MODEL, reasoning: true, reasoning_options: [{ type: 'toggle' }] },
    })))
    const ctx = new Context()
    const disposed = false
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmModelsDev, { providers: { 'opencode-free': { baseURL: 'https://opencode.ai/zen/v1' } } })

      const reasoner = await ctx.llm.resolveModelInfo('opencode-free', 'reason-free')
      expect(reasoner.reasoning?.efforts.map(effort => effort.id.toString()))
        .toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
      // No materialized default: an unselected effort leaves the wire field
      // absent and the gateway's own default serves.
      expect(reasoner.reasoning?.defaultEffort).toBeUndefined()
      const call = await ctx.llm.resolveCallConfig({ provider: 'opencode-free', model: 'reason-free' })
      expect(call.reasoningEffort).toBeUndefined()

      const plain = await ctx.llm.resolveModelInfo('opencode-free', 'chat-only')
      expect(plain.reasoning).toBeUndefined()
      const plainCall = await ctx.llm.resolveCallConfig({ provider: 'opencode-free', model: 'chat-only' })
      expect(plainCall.reasoningEffort).toBeUndefined()
      const toggle = await ctx.llm.resolveModelInfo('opencode-free', 'toggle-only')
      expect(toggle.reasoning).toBeUndefined()
    } finally {
      if (!disposed) await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('parseModelProtocols', () => {
  const RESPONSES_MODEL = {
    ...FREE_MODEL,
    cost: { input: 1.25, output: 4.25 },
    provider: { npm: '@ai-sdk/openai' },
  }

  it('maps every Responses-protocol model id, free or paid', () => {
    expect(parseModelProtocols(payload({
      'free-spark': { ...FREE_MODEL, provider: { npm: '@ai-sdk/openai' } },
      'paid-spark': RESPONSES_MODEL,
      'chat-model': FREE_MODEL,
      'other-npm': { ...FREE_MODEL, provider: { npm: '@ai-sdk/anthropic' } },
      '': FREE_MODEL,
    }), 'opencode')).toEqual(new Map([
      ['free-spark', 'responses'],
      ['paid-spark', 'responses'],
    ]))
  })

  it('rejects malformed payloads and yields an empty map for absent providers', () => {
    expect(() => parseModelProtocols(undefined, 'opencode')).toThrow(/not an object/)
    expect(parseModelProtocols({}, 'opencode')).toEqual(new Map())
    expect(() => parseModelProtocols({ opencode: {} }, 'opencode')).toThrow(/no model map/)
  })

  it('peekProtocol routes cached models without triggering a refresh', async () => {
    vi.stubGlobal('fetch', okFetchOf(() => payload({
      'free-spark': { ...FREE_MODEL, provider: { npm: '@ai-sdk/openai' } },
    })))
    const catalog = new ModelsDevCatalog('https://models.dev', 3_600_000)
    expect(catalog.peekProtocol('opencode', 'free-spark')).toBeUndefined()
    await catalog.freeModels('opencode')
    expect(catalog.peekProtocol('opencode', 'free-spark')).toBe('responses')
    expect(catalog.peekProtocol('opencode', 'test-free')).toBeUndefined()
    expect(catalog.peekProtocol('missing', 'free-spark')).toBeUndefined()
  })
})
