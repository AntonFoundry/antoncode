/**
 * Package invariant for model-intel: the resolver's credential gate and the
 * datasheet persistence round-trip are the load-bearing runtime relations.
 *
 * Registered through the shared invariants reporter: both checks run against
 * the real service in a scratch DSH home, with a stub credentials service.
 * @module @deepseek-ai/dsh-model-intel/invariant
 */

import { Context } from '@deepseek-ai/cordis'
import { ModelIntelService } from './index.ts'
import type { ModelIntelDatasheet } from './index.ts'

/** Minimal credentials stand-in: resolves only the allowlisted reference. */
const CREDENTIALS_STUB = { resolve: async (ref: string) => ref === 'ZAI_API_KEY' ? { value: 'stub-key' } : undefined }

export async function run(): Promise<void> {
  // Relation 1: the credential gate. zai resolves (key present) and stays
  // eligible; a provider whose reference is absent or unresolvable is skipped.
  const ctx = new Context()
  ctx.provide('credentials', CREDENTIALS_STUB)
  const service = new ModelIntelService(ctx, {
    enabled: true, researchIntervalHours: 168, checkIntervalMinutes: 30, researchRoute: '',
  })
  const datasheet: ModelIntelDatasheet = {
    fetchedAt: new Date().toISOString(),
    entries: [
      { provider: 'zai', model: 'glm-5.3', reasoning: 90, coding: 85, agentic: 80, speed: 70 },
      { provider: 'opencode-free', model: 'mimo-v2.5-free', reasoning: 40, coding: 35, agentic: 30, speed: 90 },
    ],
  }
  service.injectDatasheet(datasheet)
  const codingTask = await service.resolveAutoRoute('fix this typescript bug and refactor the module')
  if (codingTask === undefined || codingTask.provider !== 'zai') {
    throw new Error(`model-intel invariant: credential gate failed — expected the credentialed zai route, got ${JSON.stringify(codingTask)}`)
  }
  // Relation 2: with no datasheet the resolver answers undefined (parent
  // inheritance fallback), never a guessed route.
  const empty = new ModelIntelService(new Context(), {
    enabled: true, researchIntervalHours: 168, checkIntervalMinutes: 30, researchRoute: '',
  })
  const none = await empty.resolveAutoRoute('anything')
  if (none !== undefined) {
    throw new Error(`model-intel invariant: empty datasheet must resolve undefined, got ${JSON.stringify(none)}`)
  }
}
