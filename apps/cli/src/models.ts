/**
 * `dsh models`: boot one profile composition far enough for its LLM adapters
 * to register, print every provider route and its advertised models, then
 * exit. The boot is the honest source — settings overrides and credentials
 * reshape the catalog at runtime — so the list reflects exactly what a
 * `dsh --profile <name>` run would see.
 * @module @deepseek-ai/dsh/models
 */

import type {} from '@deepseek-ai/dsh-llm'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from './profile-boot.ts'

/** Per-provider catalog timeout: a route that cannot answer in time reads as unavailable. */
const LIST_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(undefined) },
    )
  })
}

/**
 * Print the provider/model catalog for one profile's composition and exit 0.
 * @param profile - the profile whose composition to inspect.
 */
export async function runModels(profile: string): Promise<void> {
  const { ctx, shutdown } = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile,
    patchFiles: [],
    args: [],
  })
  try {
    const providers = ctx.llm.listProviders()
    if (providers.length === 0) {
      console.log('no LLM providers registered in this composition')
      return
    }
    for (const provider of providers) {
      const auth = provider.authConfigured === false ? ' [auth not configured]' : ''
      console.log(`${provider.id} — ${provider.name}${auth}`)
      const models = await withTimeout(ctx.llm.listModels(provider.id), LIST_TIMEOUT_MS)
      if (models === undefined || models.length === 0) {
        console.log('  (no models advertised)')
        continue
      }
      for (const model of models) {
        console.log(`  ${model.id}${model.name !== model.id ? ` — ${model.name}` : ''}`)
      }
    }
  } finally {
    await shutdown.shutdown(0)
  }
}
