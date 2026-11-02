import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { fetchModelsDevDocument, MODELS_DEV_API_URL, parseModelsDevLiveModels, ZAI_REASONING_EFFORTS } from '../src/models-dev.ts'
import { NVIDIA_LLM_API_REFERENCE_URL } from '../src/nvidia-models.ts'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'

const homes: string[] = []
const servers: Server[] = []

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A throwaway $DSH_HOME with an empty settings document, as the product mounts the plugin. */
async function harness(config: LlmPiAi.Options): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-models-dev-'))
  homes.push(dir)
  await writeFile(join(dir, 'settings.yaml'), '')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
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
    }), 'zai-coding-plan', ZAI_REASONING_EFFORTS)
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
    }), 'zai-coding-plan', ZAI_REASONING_EFFORTS)
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
    const document = await fetchModelsDevDocument()
    expect(parseModelsDevLiveModels(document, 'zai-coding-plan', ZAI_REASONING_EFFORTS)).toEqual([{
      id: 'beta',
      name: 'Beta',
      contextWindow: 4096,
      maxTokens: 256,
      reasoningEfforts: { off: null, low: 'high', medium: 'high', high: 'high', max: 'max' },
    }])
    // A route of another provider adopts no Z.AI effort spellings: an unknown
    // id stays neutral and the installed catalog (or the route profile) owns
    // the dispatch facts.
    const nvidiaDocument = { nvidia: { models: { beta: {
      name: 'Beta', reasoning: true, limit: { context: 4096, output: 256 },
    } } } }
    expect(parseModelsDevLiveModels(nvidiaDocument, 'nvidia', undefined)).toEqual([
      { id: 'beta', name: 'Beta', contextWindow: 4096, maxTokens: 256 },
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    await expect(fetchModelsDevDocument()).rejects.toThrow(/failed with 503/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    expect(parseModelsDevLiveModels(await fetchModelsDevDocument(), 'zai-coding-plan')).toBeUndefined()
  })
})

describe('startup ZAI catalog refresh', () => {
  const zaiConfig = (overrides: Record<string, unknown> = {}): LlmPiAi.Options => ({
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
      // The endpoint listing extends the installed catalog rather than
      // replacing it, so its id serves first and the bundled ids remain.
      expect(ids).toEqual(['endpoint-native',
        ...getBuiltinModels('zai').map(model => model.id)])
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

describe('periodic models.dev refresh', () => {
  it('re-fetches on the configured cadence and disposal stops the timer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-models-dev-tick-'))
    homes.push(dir)
    await writeFile(join(dir, 'settings.yaml'), '')
    let document = catalogDocument({
      'glm-a': { name: 'GLM A', reasoning: true, limit: { context: 512, output: 64 } },
    })
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (url.toString() !== MODELS_DEV_API_URL) throw new Error(`unexpected fetch of ${url}`)
      return new Response(JSON.stringify(document), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    let disposed = false
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, {
        modelsDevRefreshMs: 25,
        providers: { zai: { apiKeyEnv: 'PI_MODELS_DEV_TEST_KEY', baseURL: 'http://127.0.0.1:1/v1' } },
      })
      await vi.waitFor(async () => {
        expect((await ctx.llm.listModels('zai')).map(model => model.id)).toContain('glm-a')
      })

      // The interval re-reads the republished document and the next picker
      // query sees the new ids without a restart or a settings change.
      document = catalogDocument({
        'glm-b': { name: 'GLM B', reasoning: true, limit: { context: 1024, output: 128 } },
      })
      await vi.waitFor(async () => {
        expect((await ctx.llm.listModels('zai')).map(model => model.id)).toContain('glm-b')
      })

      await ctx.fiber.dispose()
      disposed = true
      await sleep(5)
      const fetchesAtDispose = fetchMock.mock.calls.length
      await sleep(80)
      expect(fetchMock).toHaveBeenCalledTimes(fetchesAtDispose)
    } finally {
      if (!disposed) await ctx.fiber.dispose()
    }
  })
})

describe('startup NVIDIA catalog refresh', () => {
  it('serves only documented or listed chat ids, enriched with models.dev capacities', async () => {
    // models.dev's NVIDIA entry mixes real chat models with embeddings,
    // speech, and vision endpoints `/v1/chat/completions` does not serve;
    // only the documented id may serve, carrying the models.dev capacity.
    const nvidiaDocument = { nvidia: { models: {
      'deepseek-ai/deepseek-v4-flash': { name: 'DeepSeek V4 Flash', limit: { context: 1_000_000, output: 131_072 } },
      'baai/bge-m3': { name: 'BGE-M3', modalities: { input: ['text'] }, limit: { context: 8192 } },
    } } }
    const reference = [
      '# LLM APIs',
      '| Model | Endpoint |',
      '| --- | --- |',
      '| [deepseek-ai / deepseek-v4-flash](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash) | [Chat](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash-infer) |',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const target = url.toString()
      if (target === NVIDIA_LLM_API_REFERENCE_URL) return new Response(reference, { status: 200 })
      if (target === MODELS_DEV_API_URL) return new Response(JSON.stringify(nvidiaDocument), { status: 200 })
      // The account listing fails (no credential for the unreachable
      // endpoint); the documented reference alone answers membership.
      if (target.startsWith('http://127.0.0.1:1/')) return new Response('down', { status: 500 })
      throw new Error(`unexpected fetch of ${target}`)
    }))
    const ctx = await harness({ providers: {
      nvidia: { apiKeyEnv: 'PI_NVIDIA_TEST_KEY', baseURL: 'http://127.0.0.1:1/v1' },
    } })
    await vi.waitFor(async () => {
      const ids = (await ctx.llm.listModels('nvidia')).map(model => model.id)
      // The documented chat id serves with its models.dev capacity; the
      // non-chat models.dev entry (embeddings) never reaches the picker.
      expect(ids).toContain('deepseek-ai/deepseek-v4-flash')
      expect(ids).not.toContain('baai/bge-m3')
    })
    const info = await ctx.llm.resolveModelInfo('nvidia', 'deepseek-ai/deepseek-v4-flash')
    expect(info.context?.contextWindow).toBe(1_000_000)
  })

  it('unions the documented chat catalog with the account listing and configured model', async () => {
    const server = createServer((_request, response) => {
      const body = JSON.stringify({ data: [{ id: 'endpoint-only-model' }] })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
      response.end(body)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    const reference = [
      '# LLM APIs',
      '| Model | Endpoint |',
      '| --- | --- |',
      '| [deepseek-ai / deepseek-v4-flash](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash) | [Chat](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash-infer) |',
    ].join('\n')
    vi.stubEnv('PI_NVIDIA_TEST_KEY', 'test-key')
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const target = url.toString()
      if (target === NVIDIA_LLM_API_REFERENCE_URL) return new Response(reference, { status: 200 })
      if (target === `${baseURL}/models`) {
        const body = JSON.stringify({ data: [{ id: 'endpoint-only-model' }] })
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        })
      }
      throw new Error(`unexpected fetch of ${target}`)
    }))
    const ctx = await harness({ providers: {
      nvidia: {
        apiKeyEnv: 'PI_NVIDIA_TEST_KEY',
        baseURL,
        liveModelDiscovery: true,
        liveModelUnion: true,
        models: [{
          id: 'z-ai/glm-5.3-flash',
          name: 'GLM 5.3 Flash',
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          input: ['text', 'image'],
        }],
      },
    } })

    const ids = (await ctx.llm.listModels('nvidia')).map(model => model.id)
    expect(ids).toContain('z-ai/glm-5.3-flash')
    expect(ids).toContain('deepseek-ai/deepseek-v4-flash')
    expect(ids).toContain('endpoint-only-model')
  })
})
