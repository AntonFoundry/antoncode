/** NVIDIA's published live catalog for its OpenAI-compatible LLM endpoint. */

import type { PiAiLiveModel } from './catalog.ts'

/** NVIDIA's maintained API reference, whose model table targets chat completions. */
export const NVIDIA_LLM_API_REFERENCE_URL = 'https://docs.api.nvidia.com/nim/reference/llm-apis.md'

/** Network budget for the small NVIDIA LLM reference document. */
const FETCH_TIMEOUT_MS = 10_000

const PROVIDER_IDS: Readonly<Record<string, string>> = {
  'deepseek-ai': 'deepseek-ai',
  google: 'google',
  meta: 'meta',
  microsoft: 'microsoft',
  minimaxai: 'minimaxai',
  mistralai: 'mistralai',
  moonshotai: 'moonshotai',
  nvidia: 'nvidia',
  openai: 'openai',
  poolside: 'poolside',
  qwen: 'qwen',
  sarvamai: 'sarvamai',
  'stepfun-ai': 'stepfun-ai',
  stockmark: 'stockmark',
  'thinking machines': 'thinkingmachines',
  upstage: 'upstage',
  'z-ai': 'z-ai',
}

/**
 * Extract model ids from NVIDIA's documented `/v1/chat/completions` table.
 * @param markdown - NVIDIA's Markdown API reference.
 * @returns chat model ids and human-readable source labels, in document order.
 * @throws when the document no longer contains model rows this parser recognizes.
 */
export function parseNvidiaLlmModels(markdown: string): readonly PiAiLiveModel[] {
  const models: PiAiLiveModel[] = []
  const seen = new Set<string>()
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\|\s*\[([^\]]+)\]\([^)]+\)\s*\|/.exec(line)
    if (match === null) continue
    const label = match[1]
    if (label === undefined) continue
    const separator = label.lastIndexOf(' / ')
    if (separator < 1) continue
    const publisher = label.slice(0, separator).trim().toLowerCase()
    const model = label.slice(separator + 3).trim()
    const provider = PROVIDER_IDS[publisher] ?? publisher.replace(/\s+/g, '')
    if (!/^[a-z0-9-]+$/i.test(provider) || model.length === 0) continue
    const id = `${provider}/${model}`
    if (seen.has(id)) continue
    seen.add(id)
    models.push({ id, name: model })
  }
  if (models.length === 0) throw new Error('NVIDIA LLM API reference contains no recognized model rows')
  return models
}

/**
 * Keep the documented chat catalog first and append endpoint-only ids.
 * @param documented - models NVIDIA documents for its chat-completions API.
 * @param endpoint - models the configured endpoint currently advertises.
 * @returns the deduplicated model list in source priority order.
 */
export function mergeNvidiaLlmModels(
  documented: readonly PiAiLiveModel[],
  endpoint: readonly PiAiLiveModel[],
): readonly PiAiLiveModel[] {
  const models = [...documented]
  const seen = new Set(documented.map(model => model.id))
  for (const model of endpoint) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/**
 * Fetch NVIDIA's current OpenAI-compatible LLM model catalog.
 * @returns the documented chat models in NVIDIA's published order.
 * @throws when the reference cannot be fetched or parsed.
 */
export async function fetchNvidiaLlmModels(): Promise<readonly PiAiLiveModel[]> {
  const response = await fetch(NVIDIA_LLM_API_REFERENCE_URL, {
    method: 'GET',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'text/markdown' },
  })
  if (!response.ok) throw new Error(`NVIDIA LLM API reference fetch failed with ${response.status}`)
  return parseNvidiaLlmModels(await response.text())
}
