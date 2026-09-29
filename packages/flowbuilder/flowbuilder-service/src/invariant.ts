/**
 * Package-owned invariants for `@deepseek-ai/dsh-flowbuilder-service`: every
 * `flowbuilder/*` change event carries a payload that re-validates against
 * the durable record schemas and an action from the closed vocabulary.
 * @module @deepseek-ai/dsh-flowbuilder-service/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import {
  blockLibraryEntrySchema,
  flowDefinitionSchema,
} from '@deepseek-ai/dsh-flowbuilder-domain'

const PACKAGE_NAME = '@deepseek-ai/dsh-flowbuilder-service'

/** Cordis companion plugin name. */
export const name = 'flowbuilder-service-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The closed action vocabulary both change events share. */
const ACTIONS = ['saved', 'deleted'] as const

/** The minimal safeParse face the checks rely on (zod results carry `error` only on failure). */
interface SafeParseFace {
  safeParse(value: unknown): { success: boolean; error?: { message: string } }
}

/**
 * Validate one change event's action and payload against the durable schema.
 * @param eventName - the emitted event name (addressing only).
 * @param action - the action member.
 * @param record - the carried record.
 * @param schema - the record's durable schema.
 * @param fail - the invariant failure reporter.
 */
function validateChange(
  eventName: string,
  action: unknown,
  record: unknown,
  schema: SafeParseFace,
  fail: InvariantFailure,
): void {
  if (!(ACTIONS as readonly unknown[]).includes(action)) {
    fail(`${eventName} carries unknown action ${JSON.stringify(action)}`)
  }
  const parsed = schema.safeParse(record)
  if (!parsed.success) {
    fail(`${eventName} payload fails the durable schema: ${parsed.error?.message ?? 'schema rejection'}`)
  }
}

/** Install the flowbuilder change-event payload checks. */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('flowbuilder/flow-changed', (action, flow) => {
    validateChange('flowbuilder/flow-changed', action, flow, flowDefinitionSchema, fail)
  }, { global: true })
  ctx.on('flowbuilder/library-changed', (action, block) => {
    validateChange('flowbuilder/library-changed', action, block, blockLibraryEntrySchema, fail)
  }, { global: true })
}

/**
 * Register the flowbuilder service invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
