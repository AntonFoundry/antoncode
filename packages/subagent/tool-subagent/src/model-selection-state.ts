/** Durable per-session state for the user-controlled model-selection opt-in. */

import { z as zod } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { assertAllowedModelRoutes, type AllowedModelRoute } from './model-selection.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records this Session’s authorized child provider/model routes. The
     * Settings owner appends one whenever the current Settings authorization
     * differs from the recorded one; the latest event wins. An empty list
     * revokes an earlier authorization. Absence or revocation restricts
     * explicit selection to the current parent route. Log-only: it carries
     * no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-policy': {
      /** Exact routes this Session may select explicitly for a child; empty revokes selection. */
      allowedModels: AllowedModelRoute[]
    }
  }
}

const modelSelectionPolicySchema: zod.ZodType<AllowedModelRoute[] | null> = zod.array(zod.object({
  provider: zod.string().min(1),
  model: zod.string().min(1),
}).strict()).min(1).nullable()

/**
 * Host-only projection of the latest durable model-selection policy; `null` means no current authorization.
 * Each independently mounted consumer registers this shared definition; the registry reference-counts it.
 */
export const subagentModelSelectionProjectionDefinition = {
  key: 'subagentModelSelectionPolicy',
  stateVersion: 2,
  stateSchema: modelSelectionPolicySchema,
  init: () => null,
  apply: (policy, event) => {
    if (event.type !== 'subagent/model-selection-policy') return policy
    const { allowedModels } = event.data
    assertAllowedModelRoutes(allowedModels)
    return allowedModels.length === 0 ? null : allowedModels
  },
} satisfies ProjectionDefinition<'subagentModelSelectionPolicy', AllowedModelRoute[] | null>

/**
 * Read the exact route list authorized for a Session.
 * @param subagentModelSelectionProjectionHandle - registered policy state reader.
 * @param session - session whose durable decision is read.
 * @returns a detached route list, or undefined to restrict selection to the parent route.
 */
export function subagentModelSelectionPolicy(
  subagentModelSelectionProjectionHandle: Pick<ProjectionHandle<AllowedModelRoute[] | null>, 'stateOf'>,
  session: Session,
): AllowedModelRoute[] | undefined {
  return subagentModelSelectionProjectionHandle.stateOf(session)?.map(route => ({ ...route }))
}
