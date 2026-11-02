/**
 * LangFlow sidecar controller: owns the child `langflow run` process, its
 * readiness poll, and the state machine the Workflows tab renders. Plain
 * class — the plugin entry (`index.ts`) publishes it as the `langflow`
 * service and owns disposal.
 * @module @deepseek-ai/dsh-langflow-sidecar/src/sidecar
 */
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
declare module '@deepseek-ai/cordis' {
  interface Context {
    langflow: LangflowSidecar
  }
}
/** Lifecycle state of the sidecar child. */
export type LangflowState = 'stopped' | 'starting' | 'running' | 'error'
/** Snapshot the Workflows tab renders: state plus the URL once it is known. */
export interface LangflowStatus {
  state: LangflowState
  /** Base URL of the LangFlow UI; present once the child is spawning or serving. */
  url?: string | undefined
  /** Child process id; present while a child exists. */
  pid?: number | undefined
  /** Last failure reason; present in the `error` state. */
  error?: string | undefined
}
/** Resolved sidecar configuration (see the plugin entry's `Config`). */
export interface LangflowSidecarConfig {
  /** Launcher executable; `uvx` resolves `langflow` on demand through the uv cache. */
  command: string
  /** Loopback port LangFlow serves on. */
  port: number
  /** Child working directory; LangFlow stores its database and logs here. */
  workdir: string
  /** How long `start()` polls `/health` before declaring a startup failure. */
  readyTimeoutMs: number
}
export declare class LangflowSidecar {
  private readonly subprocess
  private readonly config
  private state
  private error
  private handle
  private startPromise
  constructor(subprocess: SubprocessRuntime, config: LangflowSidecarConfig)
  /** Base URL the embedded LangFlow UI loads from. */
  get url(): string
  /**
     * Snapshot the current lifecycle state.
     * @returns the status the Workflows tab renders.
     */
  status(): LangflowStatus
  /**
     * Spawn the child and poll until its HTTP server answers. Idempotent and
     * single-flight: concurrent starts share one attempt, and a start while
     * running returns the current status.
     * @returns the post-start status (`running`, or `error` with the reason).
     */
  start(): Promise<LangflowStatus>
  /**
     * Terminate the child (SIGTERM → grace → SIGKILL through the subprocess
     * seam) and drop back to `stopped`. Idempotent.
     * @returns when the whole process tree has exited.
     */
  stop(): Promise<void>
  private startInner
  /**
     * Poll the child's health endpoint. Any HTTP response counts as ready —
     * an answering server can render the UI; only transport failure keeps
     * the poll alive.
     */
  private pollUntilReady
}
//# sourceMappingURL=sidecar.d.ts.map
