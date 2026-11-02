/**
 * Package-owned invariants for `@deepseek-ai/dsh-flowbuilder-service`: change
 * events revalidate their payload against the durable record schemas, and the
 * run lifecycle pairs — a `run-node` or `run-end` references a live, known
 * run, node states name nodes of that run, and every run ends exactly once.
 * @module @deepseek-ai/dsh-flowbuilder-service/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import {
  blockLibraryEntrySchema,
  flowDefinitionSchema,
  flowNodeRunStateSchema,
  flowRunRecordSchema,
} from '@deepseek-ai/dsh-flowbuilder-domain'
import type { FlowRunId, FlowRunRecordRecord } from '@deepseek-ai/dsh-flowbuilder-domain'

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

/** Per-run pairing state the run-event checks accumulate. */
interface RunPairing {
  /** Node ids the started record declared. */
  nodeIds: Set<string>
  /** Whether the run has already ended. */
  ended: boolean
}

/** Install the flowbuilder change-event payload and run-pairing checks. */
const install: InvariantInstaller = (ctx, fail) => {
  const runs = new Map<FlowRunId, RunPairing>()

  const checkNodeState = (runId: FlowRunId, nodeId: string, state: unknown): void => {
    const pairing = runs.get(runId)
    if (pairing === undefined) {
      fail(`flowbuilder/run-node for unknown run '${runId}'`)
      return
    }
    if (pairing.ended) fail(`flowbuilder/run-node after run-end for run '${runId}'`)
    if (!pairing.nodeIds.has(nodeId)) fail(`flowbuilder/run-node names unknown node '${nodeId}' of run '${runId}'`)
    const parsed = flowNodeRunStateSchema.safeParse(state)
    if (!parsed.success) {
      fail(`flowbuilder/run-node state fails the durable schema: ${parsed.error?.message ?? 'schema rejection'}`)
    }
  }

  ctx.on('flowbuilder/flow-changed', (action, flow) => {
    validateChange('flowbuilder/flow-changed', action, flow, flowDefinitionSchema, fail)
  }, { global: true })
  ctx.on('flowbuilder/library-changed', (action, block) => {
    validateChange('flowbuilder/library-changed', action, block, blockLibraryEntrySchema, fail)
  }, { global: true })
  ctx.on('flowbuilder/run-start', (record) => {
    const parsed = flowRunRecordSchema.safeParse(record)
    if (!parsed.success) {
      fail(`flowbuilder/run-start payload fails the durable schema: ${parsed.error?.message ?? 'schema rejection'}`)
      return
    }
    const started = record as FlowRunRecordRecord
    if (runs.has(started.id)) fail(`flowbuilder/run-start repeats run '${started.id}'`)
    runs.set(started.id, { nodeIds: new Set(Object.keys(started.nodes)), ended: false })
  }, { global: true })
  ctx.on('flowbuilder/run-node', (runId, nodeId, state) => {
    checkNodeState(runId, nodeId, state)
  }, { global: true })
  ctx.on('flowbuilder/run-end', (record) => {
    const parsed = flowRunRecordSchema.safeParse(record)
    if (!parsed.success) {
      fail(`flowbuilder/run-end payload fails the durable schema: ${parsed.error?.message ?? 'schema rejection'}`)
      return
    }
    const ended = record as FlowRunRecordRecord
    const pairing = runs.get(ended.id)
    if (pairing === undefined) {
      fail(`flowbuilder/run-end for unknown run '${ended.id}'`)
      return
    }
    if (pairing.ended) fail(`flowbuilder/run-end repeats run '${ended.id}'`)
    pairing.ended = true
  }, { global: true })
}

/**
 * Register the flowbuilder service invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
