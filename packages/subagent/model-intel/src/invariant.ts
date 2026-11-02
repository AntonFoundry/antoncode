/**
 * Package invariant for model-intel: the resolver's credential gate and the
 * datasheet persistence round-trip are the load-bearing runtime relations.
 *
 * Registered through the shared invariants reporter: both checks run against
 * the real service, with a stub credentials service for the credentialed
 * route and a bare context for the empty-datasheet fallback.
 * @module @deepseek-ai/dsh-model-intel/invariant
 */

import { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { ModelIntelService } from './index.ts'
import type { ModelIntelDatasheet } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-model-intel'

/** Cordis companion plugin name. */
export const name = 'model-intel-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Minimal credentials stand-in: resolves only the allowlisted reference. */
const CREDENTIALS_STUB = { resolve: async (ref: string) => ref === 'ZAI_API_KEY' ? { value: 'stub-key' } : undefined }

/** Router configuration shared by both relations; the invariant never starts timers. */
const ROUTER_CONFIG = { enabled: true, researchIntervalHours: 168, checkIntervalMinutes: 30, researchRoute: '' } as const

const install: InvariantInstaller = async (_ctx: Context, fail: InvariantFailure): Promise<void> => {
  // Relation 1: the credential gate. zai resolves (key present) and stays
  // eligible; a provider whose reference is absent or unresolvable is skipped.
  const credentialed = new Context()
  credentialed.provide('credentials', CREDENTIALS_STUB)
  const service = new ModelIntelService(credentialed, ROUTER_CONFIG)
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
    fail(`credential gate failed — expected the credentialed zai route, got ${JSON.stringify(codingTask)}`)
    return
  }
  // Relation 2: with no datasheet the resolver answers undefined (parent
  // inheritance fallback), never a guessed route.
  const empty = new ModelIntelService(new Context(), ROUTER_CONFIG)
  const none = await empty.resolveAutoRoute('anything')
  if (none !== undefined) {
    fail(`empty datasheet must resolve undefined, got ${JSON.stringify(none)}`)
  }
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
