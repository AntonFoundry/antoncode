/**
 * LangFlow sidecar plugin entry: publishes the {@link LangflowSidecar}
 * controller as the `langflow` service and ties child teardown to the
 * plugin lifecycle.
 * @module @deepseek-ai/dsh-langflow-sidecar
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LangflowSidecar } from './sidecar.ts'
import type { LangflowSidecarConfig } from './sidecar.ts'

export { LangflowSidecar } from './sidecar.ts'
export type { LangflowState, LangflowStatus } from './sidecar.ts'

/** Cordis plugin name. */
export const name = 'langflow-sidecar'
/** The subprocess runtime must exist before the sidecar can spawn. */
export const inject = ['subprocess']

/**
 * Plugin configuration. `workdir` has NO default on purpose: a `process.cwd()`
 * fallback would scatter LangFlow's database and logs wherever the process
 * happens to start; assemblies state the location explicitly.
 */
export interface Config extends LangflowSidecarConfig {}

/** Config schema. */
export const Config: z<Config> = z.object({
  command: z.string().default('uvx'),
  port: z.number().default(7860),
  workdir: z.string().required(),
  readyTimeoutMs: z.number().default(600_000),
})

/**
 * Publish the sidecar service and register child teardown as a plugin effect.
 * @param ctx - host context carrying the subprocess runtime.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const sidecar = new LangflowSidecar(ctx.subprocess, config)
  ctx.provide('langflow', sidecar)
  ctx.effect(() => () => {
    void sidecar.stop()
  }, 'langflow-sidecar.dispose')
}
