/**
 * LangFlow sidecar controller: owns the child `langflow run` process, its
 * readiness poll, and the state machine the Workflows tab renders. Plain
 * class — the plugin entry (`index.ts`) publishes it as the `langflow`
 * service and owns disposal.
 * @module @deepseek-ai/dsh-langflow-sidecar/src/sidecar
 */

import { mkdir } from 'node:fs/promises'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { LangflowState, LangflowStatus } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    langflow: LangflowSidecar
  }
}

/** Lifecycle state of the sidecar child. */
export type { LangflowState, LangflowStatus } from './types.ts'

/** Snapshot the Workflows tab renders: state plus the URL once it is known. */

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

/** Bound between readiness probes; also the per-probe fetch timeout. */
const PROBE_INTERVAL_MS = 500
const PROBE_TIMEOUT_MS = 1500
/** Stdio tail retained for error reports. */
const TAIL_BYTES = 262144
/** Terminate escalation grace period handed to the subprocess seam. */
const GRACE_MS = 8000

/**
 * Supervise the embedded LangFlow subprocess: start it for the Workflows tab,
 * report readiness by polling `/health`, and tear it down on dispose.
 */
export class LangflowSidecar {
  private state: LangflowState = 'stopped'
  private error: string | undefined
  private handle: SubprocessHandle | undefined
  private startPromise: Promise<LangflowStatus> | undefined

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly config: LangflowSidecarConfig,
  ) {}

  /** Base URL the embedded LangFlow UI loads from. */
  get url(): string {
    return `http://127.0.0.1:${this.config.port}/`
  }

  /**
   * Snapshot the current lifecycle state.
   * @returns the status the Workflows tab renders.
   */
  status(): LangflowStatus {
    return {
      state: this.state,
      ...(this.state === 'running' || this.state === 'starting' ? { url: this.url } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
    }
  }

  /**
   * Spawn the child and poll until its HTTP server answers. Idempotent and
   * single-flight: concurrent starts share one attempt, and a start while
   * running returns the current status.
   * @returns the post-start status (`running`, or `error` with the reason).
   */
  start(): Promise<LangflowStatus> {
    if (this.state === 'running') return Promise.resolve(this.status())
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.startInner().finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  /**
   * Terminate the child (SIGTERM → grace → SIGKILL through the subprocess
   * seam) and drop back to `stopped`. Idempotent.
   * @returns when the whole process tree has exited.
   */
  async stop(): Promise<void> {
    const child = this.handle
    this.handle = undefined
    this.state = 'stopped'
    this.error = undefined
    if (child === undefined) return
    child.terminate()
    await child.waitForExit()
  }

  private async startInner(): Promise<LangflowStatus> {
    this.error = undefined
    this.state = 'starting'
    await mkdir(this.config.workdir, { recursive: true })
    const child = this.subprocess.spawn({
      argv: [this.config.command, 'langflow', 'run', '--host', '127.0.0.1', '--port', String(this.config.port)],
      cwd: this.config.workdir,
      stdio: { stdin: 'ignore', stdout: { maxBytes: TAIL_BYTES }, stderr: { maxBytes: TAIL_BYTES } },
      graceMs: GRACE_MS,
    })
    this.handle = child
    const outcome = await Promise.race([
      this.pollUntilReady(child),
      // `done` rejects for a spawn or provider failure and resolves with the
      // exit facts otherwise, so both arrive on the same channel.
      child.done.then(
        exit => ({ kind: 'exited' as const, exit }),
        (cause: unknown) => ({ kind: 'spawn-failed' as const, cause }),
      ),
      delay(this.config.readyTimeoutMs).then(() => ({ kind: 'timeout' as const })),
    ])
    if (outcome.kind === 'ready') return this.status()
    await this.stop()
    this.state = 'error'
    this.error = outcome.kind === 'timeout'
      ? `langflow did not become ready within ${this.config.readyTimeoutMs} ms (first run downloads the package; retry or raise readyTimeoutMs)`
      : outcome.kind === 'spawn-failed'
        ? `spawning '${this.config.command} langflow run' failed (the launcher was not found or refused to start)`
        : `langflow exited (code ${outcome.exit.exitCode ?? `signal ${String(outcome.exit.signal)}`}) before readiness: ${stderrTail(child)}`
    return this.status()
  }

  /**
   * Poll the child's health endpoint. Any HTTP response counts as ready —
   * an answering server can render the UI; only transport failure keeps
   * the poll alive.
   */
  private async pollUntilReady(child: SubprocessHandle): Promise<{ kind: 'ready' }> {
    for (;;) {
      if (this.handle !== child) throw new Error('start superseded by stop')
      try {
        await fetch(`http://127.0.0.1:${this.config.port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        this.state = 'running'
        return { kind: 'ready' }
      } catch {
        // Connection refused or probe timeout — the server is not up yet.
      }
      await delay(PROBE_INTERVAL_MS)
    }
  }
}

/** The retained stderr tail, flattened to the last lines for an error report. */
function stderrTail(child: SubprocessHandle): string {
  const read = child.collected.stderr?.readFrom(0)
  if (read === undefined || read.text.trim() === '') return 'no stderr captured'
  const lines = read.text.trimEnd().split('\n')
  return lines.slice(-4).join(' | ').slice(-400)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
