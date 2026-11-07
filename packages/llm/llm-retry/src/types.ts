import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

/** A failed or incompatible route considered in one bounded recovery chain. */
export interface FailoverAttempt {
  selection: ModelSelection
  code: string
}

/** Durable automatic route change, including a cooldown's primary probe. */
export interface LlmFailoverEventData {
  primary: ModelSelection
  from: ModelSelection
  to: ModelSelection
  reason: 'failure' | 'cooldown-expired'
  failureCode?: string
  cooldownUntil: number
  turn: number
  step: number
}

/** Durable failure history used to recover an interrupted retry budget. */
export interface LlmFailoverAttemptEventData {
  primary: ModelSelection
  attempt: FailoverAttempt
  startedAt: number
  turn: number
  step: number
}

/** Terminal recovery failure with route identifiers and stable failure codes only. */
export interface LlmFailoverExhaustedEventData {
  primary: ModelSelection
  attempted: FailoverAttempt[]
  turn: number
  step: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Logged automatic model-switch or exhaustion notice.
     * @persistenceAttribution
     */
    'model-failover': { kind: 'model-failover' } & ContextFormed
  }
}
import type { RetryId } from './brand.ts'

export type { RetryId }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable, non-surface record of one provider-routed retry scheduled after a failed request attempt. */
    'llm/retry': LlmRetryEventData
    /** Durable transition written after a retry wait succeeds and before the next request attempt starts. */
    'llm/retry-started': LlmRetryStartedEventData
    /** Log-only automatic route switch; the accompanying notice is a logged user message. */
    'llm/failover': LlmFailoverEventData
    /** Log-only failed attempt in a bounded automatic recovery chain. */
    'llm/failover-attempt': LlmFailoverAttemptEventData
    /** Log-only terminal automatic recovery outcome. */
    'llm/failover-exhausted': LlmFailoverExhaustedEventData
  }
}

/** Durable payload recorded before one provider-routed model-request retry wait. */
export type LlmRetryEventData =
  | {
    retryId: RetryId
    turn: number
    step: number
    provider: string
    mode: 'normal'
    policyKey: string
    retry: number
    maxRetries: number
    delayMs: number
    failure: LlmFailure
  }

  | {
    retryId: RetryId
    turn: number
    step: number
    provider: string
    mode: 'always'
    policyKey: string
    retry: number
    delayMs: number
    failure: LlmFailure
  }

/** Durable transition recorded after one retry delay completes. */
export interface LlmRetryStartedEventData {
  retryId: RetryId
  turn: number
  step: number
  retry: number
}
