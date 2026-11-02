import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchNvidiaLlmModels, mergeNvidiaLlmModels, NVIDIA_LLM_API_REFERENCE_URL, parseNvidiaLlmModels } from '../src/nvidia-models.ts'

afterEach(() => vi.unstubAllGlobals())

describe('NVIDIA LLM API model catalog', () => {
  it('reads namespaced chat model ids from the official model table', () => {
    const models = parseNvidiaLlmModels([
      '# LLM APIs',
      '| Model | Endpoint |',
      '| --- | --- |',
      '| [deepseek-ai / deepseek-v4-flash](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash) | [Chat](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash-infer) |',
      '| [thinking machines / inkling](https://docs.api.nvidia.com/nim/reference/thinkingmachines-inkling) | [Chat](https://docs.api.nvidia.com/nim/reference/thinkingmachines-inkling-infer) |',
      '| [new publisher / model-2](https://docs.api.nvidia.com/nim/reference/new-publisher-model-2) | [Chat](https://docs.api.nvidia.com/nim/reference/new-publisher-model-2-infer) |',
    ].join('\n'))

    expect(models).toEqual([
      { id: 'deepseek-ai/deepseek-v4-flash', name: 'deepseek-v4-flash' },
      { id: 'thinkingmachines/inkling', name: 'inkling' },
      { id: 'newpublisher/model-2', name: 'model-2' },
    ])
  })

  it('deduplicates documented and account-advertised ids while retaining both sources', () => {
    expect(mergeNvidiaLlmModels([
      { id: 'deepseek-ai/deepseek-v4-flash', name: 'deepseek-v4-flash' },
    ], [
      { id: 'deepseek-ai/deepseek-v4-flash' },
      { id: 'endpoint-only-model' },
    ])).toEqual([
      { id: 'deepseek-ai/deepseek-v4-flash', name: 'deepseek-v4-flash' },
      { id: 'endpoint-only-model' },
    ])
  })

  it('fetches the API reference as Markdown and refuses an unrecognized document', async () => {
    const markdown = '| [deepseek-ai / deepseek-v4-flash](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash) | [Chat](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash-infer) |'
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(url.toString()).toBe(NVIDIA_LLM_API_REFERENCE_URL)
      expect(init?.headers).toEqual({ accept: 'text/markdown' })
      return new Response(markdown, { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)

    await expect(fetchNvidiaLlmModels()).resolves.toEqual([
      { id: 'deepseek-ai/deepseek-v4-flash', name: 'deepseek-v4-flash' },
    ])
    expect(fetch).toHaveBeenCalledOnce()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# changed', { status: 200 })))
    await expect(fetchNvidiaLlmModels()).rejects.toThrow(/no recognized model rows/)
  })
})
