/** Client-safe LangFlow sidecar state. */
export type LangflowState = 'stopped' | 'starting' | 'running' | 'error'

/** Snapshot of the embedded LangFlow process. */
export interface LangflowStatus {
  readonly state: LangflowState
  readonly url?: string | undefined
  readonly error?: string | undefined
}
