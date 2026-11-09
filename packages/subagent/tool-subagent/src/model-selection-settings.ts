/** Host-owned opt-in setting for model-selectable subagent delegation. */
import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: the Loader's `loader/volatile-update` event, which reports Settings edits to the running fiber.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import {
  subagentModelSelectionPolicy,
  subagentModelSelectionProjectionDefinition,
} from './model-selection-state.ts'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  modelRouteKey,
  type AllowedModelRoute,
} from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference recorded into every live Agent Session. */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** Stored user preference; the shipped composition defaults it off. */
export interface SubagentModelSelectionSettings {
  /** Whether live Sessions receive model selection. */
  enabled: boolean
  /** Exact child LLM routes offered to live Sessions. */
  allowedModels: AllowedModelRoute[]
}

/** Optional deployment base for the preference. */
export interface Config {
  /** Initial enabled state inherited when the user document does not override it. */
  enabled: Volatile<boolean>
  /** Initial route list inherited when the user document does not override it. */
  allowedModels: Volatile<AllowedModelRoute[]>
}

/** Whether two recorded or desired route lists authorize the same routes in the same order. */
function sameRoutes(
  recorded: readonly AllowedModelRoute[] | undefined,
  desired: readonly AllowedModelRoute[] | undefined,
): boolean {
  if (recorded === undefined || desired === undefined) return recorded === desired
  return recorded.length === desired.length
    && recorded.every((route, index) => {
      const other = desired[index]
      return other !== undefined && modelRouteKey(route) === modelRouteKey(other)
    })
}

/**
 * Host settings owner that keeps every live Agent Session's recorded authorization equal to the current Settings.
 * It records on Agent publication (fresh, resumed, seeded, and child Sessions alike) before the first model request,
 * where invalid Settings reject publication. On activation and after each Settings edit it records for every live
 * Agent; invalid Settings then revoke live authorizations, and a Session whose append fails is logged and skipped.
 */
export class SubagentModelSelectionConfig extends Service {
  static inject = ['sessionProjections', 'agents']

  static Config = z.object({
    enabled: z.boolean().default(false).volatile(),
    allowedModels: z.array(AllowedModelRouteSchema).default([]).volatile(),
  })

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'subagentModelSelection')
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const policyReady = ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    ctx.on('agent/created', async ({ agent }) => {
      const policy = await policyReady
      ctx.fiber.assertActive()
      record(policy, agent.session, this.authorizedRoutes())
    })
    const policy = await policyReady
    ctx.fiber.assertActive()
    const recordLive = (): void => {
      let desired: AllowedModelRoute[] | undefined
      try {
        desired = this.authorizedRoutes()
      } catch (error: unknown) {
        // Invalid Settings fail closed: `desired` stays undefined, which revokes live authorizations.
        ctx.logger.warn(`subagent model selection settings are invalid; revoking model selection in live Sessions: ${String(error)}`)
      }
      for (const agent of ctx.agents.list()) {
        try {
          record(policy, agent.session, desired)
        } catch (error: unknown) {
          // One rejected append must not keep the remaining live Sessions on a stale policy.
          ctx.logger.warn(`subagent model selection policy was not recorded in session "${agent.id}": ${String(error)}`)
        }
      }
    }
    ctx.on('loader/volatile-update', recordLive)
    recordLive()
  }

  /**
   * Read the current Settings authorization.
   * @returns detached exact routes, or undefined when selection is disabled.
   */
  private authorizedRoutes(): AllowedModelRoute[] | undefined {
    const enabled = this.config.enabled.get()
    const allowedModels = this.config.allowedModels.get()
    assertAllowedModelRoutes(allowedModels)
    if (enabled && allowedModels.length === 0) {
      throw new Error('enabled subagent model selection requires at least one allowed model')
    }
    return enabled ? allowedModels.map(route => ({ ...route })) : undefined
  }

}

/**
 * Append the desired authorization when it differs from the Session's recorded one.
 * Revocation is recorded as an empty list only when the Session has a recorded authorization.
 */
function record(
  policy: ProjectionHandle<AllowedModelRoute[] | null>,
  session: Session,
  desired: AllowedModelRoute[] | undefined,
): void {
  if (sameRoutes(subagentModelSelectionPolicy(policy, session), desired)) return
  session.append('subagent/model-selection-policy', { allowedModels: desired ?? [] })
}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
