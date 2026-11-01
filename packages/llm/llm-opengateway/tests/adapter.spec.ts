/**
 * Discovery behavior of the OpenGateway adapter: catalog-to-picker mapping,
 * the empty picker an outage serves, and the catalog-supplied facts model
 * resolution adds to the inherited OpenAI defaults.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { Config } from '@deepseek-ai/dsh-llm-opengateway'
import {
  OpenGatewayAdapter,
  OpenGatewayCatalog,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-opengateway'

function payload(entries: Array<Record<string, unknown>>): unknown {
  return { data: entries }
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'deepseek/deepseek-v4-flash',
    status: 'active',
    modalities: { input: ['text'] },
    endpoints: ['chat_completions'],
    context_window: 1_000_000,
    max_output_tokens: 65_536,
    ...overrides,
  }
}

function stubCatalog(models: () => unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => models() }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Composition defaults the stub route resolves over. */
const ROUTE: Config = { baseURL: 'https://gw.test/v1' }

function adapterOf(overrides: Config = {}): {
  adapter: OpenGatewayAdapter
  catalog: OpenGatewayCatalog
  fetchMock: ReturnType<typeof vi.fn>
} {
  const fetchMock = stubCatalog(() => payload([entry()]))
  const catalog = new OpenGatewayCatalog(3_600_000)
  const adapter = new OpenGatewayAdapter({
    options: () => resolveAdapterOptions(Object.assign({}, ROUTE, overrides)),
    resolveApiKey: async () => 'unused',
    resolveUserId: () => 'anonymous' as AnonymousUserId,
    catalog,
    modelProtocol: (_provider, model) => catalog.peekProtocol('https://gw.test/v1', model) ?? 'chat-completions',
    onCatalogError: () => {},
  })
  return { adapter, catalog, fetchMock }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenGatewayAdapter discovery', () => {
  it('lists the catalog with selector names and text-only input', async () => {
    const fetchMock = stubCatalog(() => payload([
      entry({ id: 'named/model' }),
      entry({ id: 'unnamed/model' }),
    ]))
    const catalog = new OpenGatewayCatalog(3_600_000)
    const adapter = new OpenGatewayAdapter({
      options: () => resolveAdapterOptions({}),
      resolveApiKey: async () => 'unused',
      resolveUserId: () => 'anonymous' as AnonymousUserId,
      catalog,
    })
    await expect(adapter.listModels('opengateway')).resolves.toEqual([
      { provider: 'opengateway', id: 'named/model', name: 'named/model', inputModalities: ['text'] },
      { provider: 'opengateway', id: 'unnamed/model', name: 'unnamed/model', inputModalities: ['text'] },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('serves an empty picker when the catalog is unreachable, without rejecting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })))
    const catalog = new OpenGatewayCatalog(3_600_000)
    const adapter = new OpenGatewayAdapter({
      options: () => resolveAdapterOptions({}),
      resolveApiKey: async () => 'unused',
      resolveUserId: () => 'anonymous' as AnonymousUserId,
      catalog,
    })
    await expect(adapter.listModels('opengateway')).resolves.toEqual([])
  })

  it('enriches resolution with catalog context, output cap, and label', async () => {
    const { adapter } = adapterOf()
    await adapter.listModels('opengateway')
    await expect(adapter.resolveModel('opengateway', 'deepseek/deepseek-v4-flash')).resolves.toMatchObject({
      provider: 'opengateway',
      id: 'deepseek/deepseek-v4-flash',
      name: 'deepseek/deepseek-v4-flash',
      inputModalities: ['text'],
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 65_536,
    })
  })

  it('falls back to the inherited defaults for a model the snapshot has not seen', async () => {
    const { adapter } = adapterOf()
    await expect(adapter.resolveModel('opengateway', 'unknown/model')).resolves.toMatchObject({
      provider: 'opengateway',
      id: 'unknown/model',
      name: 'unknown/model',
      inputModalities: ['text'],
      context: { contextWindow: 128_000 },
      defaultMaxTokens: 16_384,
    })
  })

  it('offers the route effort ladder on every model, catalogued or not', async () => {
    const { adapter } = adapterOf()
    await adapter.listModels('opengateway')
    await expect(adapter.resolveModel('opengateway', 'deepseek/deepseek-v4-flash')).resolves.toMatchObject({
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
      },
    })
    // A snapshot outage leaves the ladder intact: the control is route state,
    // not a catalog fact.
    await expect(adapter.resolveModel('opengateway', 'unlisted/model')).resolves.toMatchObject({
      reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
    })
  })

  it('labels a custom ladder and hides the control when it is empty', async () => {
    const custom = adapterOf({ reasoningEfforts: ['none', 'low', 'xhigh', 'max'] })
    await expect(custom.adapter.resolveModel('opengateway', 'unlisted/model')).resolves.toMatchObject({
      reasoning: {
        efforts: [
          { id: 'none', name: 'None' },
          { id: 'low', name: 'Low' },
          { id: 'xhigh', name: 'Extra High' },
          { id: 'max', name: 'Max' },
        ],
      },
    })
    const off = adapterOf({ reasoningEfforts: [] })
    const info = await off.adapter.resolveModel('opengateway', 'unlisted/model')
    expect(info.reasoning).toBeUndefined()
  })

  it('reports route identity and the configured retry policy', () => {
    const { adapter } = adapterOf({ retryPolicy: { mode: 'always' } })
    expect(adapter.providerInfo('opengateway')).toEqual({ id: 'opengateway', name: 'OpenGateway' })
    expect(adapter.providerRetryPolicy('opengateway')).toMatchObject({ mode: 'always' })
  })

  it('declares the Responses protocol only for a Responses-only catalog entry', async () => {
    stubCatalog(() => payload([
      entry({ id: 'chat-model' }),
      entry({ id: 'responses-model', endpoints: ['responses'] }),
    ]))
    const catalog = new OpenGatewayCatalog(3_600_000)
    const adapter = new OpenGatewayAdapter({
      options: () => resolveAdapterOptions({ baseURL: 'https://gw.test/v1' }),
      resolveApiKey: async () => 'unused',
      resolveUserId: () => 'anonymous' as AnonymousUserId,
      catalog,
      modelProtocol: (_provider, model) => catalog.peekProtocol('https://gw.test/v1', model) ?? 'chat-completions',
    })
    await adapter.listModels('opengateway')
    expect(catalog.peekProtocol('https://gw.test/v1', 'chat-model')).toBeUndefined()
    expect(catalog.peekProtocol('https://gw.test/v1', 'responses-model')).toBe('responses')
  })
})
