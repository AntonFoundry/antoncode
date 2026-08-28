import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { fetchModelsDevLiveModels, MODELS_DEV_API_URL, parseModelsDevLiveModels } from '../src/models-dev.ts'

const homes: string[] = []
const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A throwaway $DSH_HOME with an empty settings document, as the product mounts the plugin. */
async function harness(config: LlmPiAi.Config): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-models-dev-'))
  homes.push(dir)
  await writeFile(join(dir, 'settings.yaml'), '')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

/** The models.dev document shape the mapping reads, narrowed to one provider entry. */
function catalogDocument(models: Record<string, unknown>): unknown {
  return {
    'other-provider': { models: { skipped: {} } },
    'zai-coding-plan': { models },
  }
}

describe('models.dev live model mapping', () => {
  it('maps capacities, labels, and reasoning efforts in document order', () => {
    const models = parseModelsDevLiveModels(catalogDocument({
      'glm-5.3-flash': {
        name: 'GLM-5.3-Flash',
        reasoning: true,
        modalities: { input: ['text', 'image', 'video'] },
        limit: { context: 1_000_000, output: 131_072 },
      },
      'glm-9-lite': { limit: {} },
      'glm-deaf': { modalities: { input: ['video'] } },
    }), 'zai-coding-plan')
    expect(models).toEqual([
      {
        id: 'glm-5.3-flash',
        name: 'GLM-5.3-Flash',
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        reasoningEfforts: { off: null, low: 'high', medium: 'high', high: 'high', max: 'max' },
        input: ['text', 'image'],
      },
      { id: 'glm-9-lite' },
      { id: 'glm-deaf' },
    ])
  })

  it('skips deprecated entries and answers undefined for an unpublished provider', () => {
    const models = parseModelsDevLiveModels(catalogDocument({
      retired: { status: 'deprecated', limit: { context: 8 } },
    }), 'zai-coding-plan')
    expect(models).toEqual([])
    expect(parseModelsDevLiveModels({ unrelated: {} }, 'zai-coding-plan')).toBeUndefined()
  })

  it('refuses payloads that are not the models.dev document', () => {
    expect(() => parseModelsDevLiveModels('nope', 'zai-coding-plan')).toThrow(/not an object/)
    expect(() => parseModelsDevLiveModels({ 'zai-coding-plan': {} }, 'zai-coding-plan')).toThrow(/no model map/)
  })

  it('fetches the document over the network and refuses failures', async () => {
    const ok = catalogDocument({ beta: { name: 'Beta', reasoning: true, limit: { context: 4096, output: 256 } } })
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (url.toString() === MODELS_DEV_API_URL) return new Response(JSON.stringify(ok), { status: 200 })
      return new Response('nope', { status: 404 })
    }))
    expect(await fetchModelsDevLiveModels()).toEqual([{
      id: 'beta',
      name: 'Beta',
      contextWindow: 4096,
      maxTokens: 256,
      reasoningEfforts: { off: null, low: 'high', medium: 'high', high: 'high', max: 'max' },
    }])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    await expect(fetchModelsDevLiveModels()).rejects.toThrow(/failed with 503/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    await expect(fetchModelsDevLiveModels()).rejects.toThrow(/no longer publishes/)
  })
})

describe('startup ZAI catalog refresh', () => {
  const zaiConfig = (overrides: Record<string, unknown> = {}): LlmPiAi.Config => ({
    providers: { zai: { apiKeyEnv: 'PI_MODELS_DEV_TEST_KEY', baseURL: 'http://127.0.0.1:1/v1', ...overrides } },
  })

  it('serves the models.dev list by default, keeping installed configuration for known ids', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (url.toString() !== MODELS_DEV_API_URL) throw new Error(`unexpected fetch of ${url}`)
      const document = catalogDocument({
        'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 512, output: 64 } },
        'glm-5.3-flash': { name: 'GLM-5.3-Flash', reasoning: true, limit: { context: 262_144, output: 65_536 } },
      })
      return new Response(JSON.stringify(document), { status: 200 })
    }))
    const ctx = await harness(zaiConfig())
    // The refresh runs at mount; both ids must appear without any other trigger.
    const ids: string[] = []
    await vi.waitFor(async () => {
      ids.length = 0
      ids.push(...(await ctx.llm.listModels('zai')).map(model => model.id))
    })
    // Capacities come from the catalog payload; a fresh model reasons through
    // the efforts the mapping declares.
    const info = await ctx.llm.resolveModelInfo('zai', 'glm-5.3-flash')
    expect(info.context?.contextWindow).toBe(262_144)
    expect(info.reasoning?.efforts.map(effort => effort.id)).toContain('max')
  })

  it('falls back to the endpoint listing when the models.dev fetch fails', async () => {
    const server = createServer((_request, response) => {
      const body = JSON.stringify({
        data: [{ id: 'endpoint-native' }],
      })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
      response.end(body)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const address = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const target = url.toString()
      if (target === MODELS_DEV_API_URL) return new Response('down', { status: 500 })
      if (target === `${address}/models`) {
        const body = JSON.stringify({ data: [{ id: 'endpoint-native' }] })
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        })
      }
      throw new Error(`unexpected fetch of ${target}`)
    }))
    const ctx = await harness(zaiConfig({ baseURL: address }))
    vi.stubEnv('PI_MODELS_DEV_TEST_KEY', 'test-key')
    await vi.waitFor(async () => {
      const ids = (await ctx.llm.listModels('zai')).map(model => model.id)
      expect(ids).toEqual(['endpoint-native'])
    })
  })

  it('keeps the bundled catalog serving when every source fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })))
    const ctx = await harness(zaiConfig())
    const ids: string[] = []
    await vi.waitFor(async () => {
      ids.length = 0
      ids.push(...(await ctx.llm.listModels('zai')).map(model => model.id))
    })
    expect(ids).toEqual(['glm-4.7', 'glm-5-turbo', 'glm-5.2', 'glm-5.2-highspeed', 'glm-5.3'])
  })
})
