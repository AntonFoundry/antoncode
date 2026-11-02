/**
 * Shared terminal-outcome vocabulary for one subagent epoch.
 *
 * Both the live lifecycle edge (`lifecycle.ts`) and the durable
 * `subagentOutcome` session projection need to answer the same question: how
 * did this child's epoch end? Keeping one implementation here means the red dot
 * a human sees in the catalog and the `subagent/end` notice the master reads
 * cannot disagree about whether work succeeded.
 *
 * @module @deepseek-ai/dsh-subagent/stop-reason
 */

import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from './types.ts'

/**
 * Why this child's epoch ended, for the terminal lifecycle edge and the
 * manager's own parent delivery. The child's own log is authoritative:
 * teardown succeeding says nothing about whether the model errored, hit its
 * token ceiling, or was cancelled, so deriving the reason from disposal would
 * report failed work as completed.
 *
 * {@link foldConsumedWork} supplies both halves the raw turn sequence cannot:
 * which turn accounts for the work this epoch consumed, and whether accepted
 * work was cancelled after it without any turn opening over it. A recorded
 * failure still wins over a cancellation — stopping a child that had already
 * failed does not turn its failure into a cancellation.
 * @param events - this epoch's own event suffix.
 * @returns its terminal stop reason; `completed` only for an epoch that both
 *   closed cleanly and had nothing left to run.
 */
export function epochStopReason(events: readonly SessionEvent[]): SubagentResult['stopReason'] {
  const { end, droppedUnrun } = foldConsumedWork(events)
  switch (end?.data.reason.kind) {
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    case 'error':
      return 'error'
    // A pre-step rejection — a hook deny, a policy plugin — discarded input
    // this epoch had claimed: the work was declined, not done.
    case 'blocked':
      return 'refusal'
    // A clean ending and no accounting turn at all share one rule: the epoch
    // finished what it was given unless a cancelled queue says otherwise.
    case undefined:
    case 'completed':
      return droppedUnrun ? 'aborted' : 'completed'
    /* v8 ignore next 3 -- `TurnEndReason` is merge-extensible, so this arm needs a
     * backend that adds a variant; treating an unnameable reason as success would
     * report failed work as completed. */
    default:
      return 'error'
  }
}

/**
 * The human-readable failure detail one `turn/end` carries, when it carries one.
 * A `completed` or `aborted` ending has no error to report.
 * @param events - the epoch's own event suffix.
 * @returns the failure message, or undefined when the epoch did not error.
 */
export function epochFailureDetail(events: readonly SessionEvent[]): string | undefined {
  const { end } = foldConsumedWork(events)
  const reason = end?.data.reason
  if (reason === undefined || reason.kind !== 'error') return undefined
  const message = reason.error?.message
  return typeof message === 'string' && message.length > 0 ? message : undefined
}
