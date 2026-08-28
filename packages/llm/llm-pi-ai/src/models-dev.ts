/**
 * Startup ZAI model-list refresh from models.dev — the same catalog source
 * OpenCode reads (`GET /api.json`), fetched when the harness mounts so a
 * provider's newest model ids reach the pickers without waiting for a pi-ai
 * release. The payload's `zai-coding-plan` entry describes the gateway the
 * harness `zai` route already serves (`api.z.ai/api/coding/paas/v4`), so its
 * models ride the installed catalog's route facts and, for ids the installed
 * catalog also ships, its full per-model configuration.
 *
 * @module dsh-llm-pi-ai/models-dev
 */

import type { PiAiLiveModel, PiAiReasoningEfforts } from './catalog.ts'

/** The models.dev document root. An external spec, not a deployment tunable. */
export const MODELS_DEV_API_URL = 'https://models.dev/api.json'

/**
 * The models.dev provider entry the refresh reads. Its endpoint is the same
 * coding gateway the installed `zai` catalog ships, so the ids are addressable
 * by the route's existing base URL and credential.
 */
export const ZAI_CATALOG_PROVIDER = 'zai-coding-plan'

/** The catalog request budget; the refresh must never delay startup materially. */
const FETCH_TIMEOUT_MS = 10_000

/**
 * The reasoning-effort map a reasoning-capable ZAI model offers. Z.AI dispatch
 * spells thinking as enabled ("high") or its extended tier ("max"); the
 * installed glm-5.2 catalog entry declares the same spellings. `off` sends
 * nothing, which is how not thinking is expressed on this gateway.
 */
const ZAI_REASONING_EFFORTS: PiAiReasoningEfforts = {
  off: null,
  low: 'high',
  medium: 'high',
  high: 'high',
  max: 'max',
}

/** The fields of one models.dev model entry the mapping reads. */
interface WireModel {
  name?: unknown
  status?: unknown
  reasoning?: unknown
  modalities?: { input?: unknown }
  limit?: { context?: unknown; output?: unknown }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A positive integer field, or `undefined` when absent or unusable. */
function capacity(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * The declared input modalities, narrowed to the harness vocabulary. Chat
 * requires text, so a payload without text (or without modalities at all)
 * answers `undefined` — the route default applies instead.
 */
function declaredInput(value: unknown): readonly ('text' | 'image')[] | undefined {
  if (!Array.isArray(value)) return undefined
  const mods = value.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
  return mods.includes('text') ? mods : undefined
}

/**
 * Extract one provider's live models from a parsed models.dev payload.
 *
 * Deprecated entries are skipped: a model the catalog itself retires must not
 * reach the pickers. A reasoning-capable entry carries the ZAI effort map, so
 * a model the installed catalog has never heard of still dispatches thinking;
 * an entry the installed catalog also ships keeps the installed configuration,
 * which wins over anything the catalog payload could restate.
 *
 * @param payload - the parsed `/api.json` document.
 * @param provider - the models.dev provider id to extract.
 * @returns the live models in document order, or `undefined` when the payload
 *   has no such provider.
 */
export function parseModelsDevLiveModels(payload: unknown, provider: string): readonly PiAiLiveModel[] | undefined {
  if (!isRecord(payload)) throw new Error('llm-pi-ai: models.dev payload is not an object')
  const entry = payload[provider]
  if (entry === undefined) return undefined
  if (!isRecord(entry) || !isRecord(entry.models)) {
    throw new Error(`llm-pi-ai: models.dev provider "${provider}" has no model map`)
  }
  const models: PiAiLiveModel[] = []
  for (const [id, raw] of Object.entries(entry.models)) {
    if (typeof id !== 'string' || id.length === 0 || !isRecord(raw)) continue
    const model = raw as WireModel
    if (model.status === 'deprecated') continue
    const reasoning = model.reasoning === true
    const contextWindow = capacity(model.limit?.context)
    const maxTokens = capacity(model.limit?.output)
    const input = declaredInput(model.modalities?.input)
    models.push({
      id,
      ...(typeof model.name === 'string' && model.name.length > 0 ? { name: model.name } : {}),
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...reasoning ? { reasoningEfforts: { ...ZAI_REASONING_EFFORTS } } : {},
      ...input === undefined ? {} : { input },
    })
  }
  return models
}

/**
 * Fetch the ZAI route's live model list from models.dev.
 * @returns the advertised models in document order.
 * @throws when the fetch fails, the reply is not the models.dev document, or
 *   the document no longer publishes {@link ZAI_CATALOG_PROVIDER}; the caller
 *   falls back to the endpoint's own listing.
 */
export async function fetchModelsDevLiveModels(): Promise<readonly PiAiLiveModel[]> {
  const response = await fetch(MODELS_DEV_API_URL, { method: 'GET', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`models.dev fetch failed with ${response.status}`)
  }
  const models = parseModelsDevLiveModels(await response.json(), ZAI_CATALOG_PROVIDER)
  if (models === undefined) {
    throw new Error(`models.dev no longer publishes "${ZAI_CATALOG_PROVIDER}"`)
  }
  return models
}
