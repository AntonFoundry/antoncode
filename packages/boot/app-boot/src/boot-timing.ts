/**
 * Phase timing for one boot.
 *
 * Marks are recorded against the process clock (`performance.now()` measures
 * from process start), so the first mark also carries module import and
 * argument parsing. Recording is unconditional and cheap; nothing prints on
 * its own, and the caller decides where the report goes.
 * @module @deepseek-ai/dsh-app-boot/boot-timing
 */

/** One boot phase and the gap from the previous mark. */
export interface BootPhaseTiming {
  /** Stable phase name (`heal`, `compose`, `mount`, `settle`, `activate`). */
  phase: string
  /** Milliseconds from process start until this phase finished. */
  atMs: number
  /** Milliseconds this phase itself took: the gap from the previous mark. */
  durationMs: number
}

/**
 * Collect boot phase durations for one process.
 *
 * A phase ends at its {@link BootTiming.mark}; the duration is the gap from the
 * previous mark (or from process start for the first one), so marks must be
 * taken in boot order. The summary is one line suitable for a diagnostic
 * channel: `heal=1830ms compose=42ms total=1872ms`.
 */
export class BootTiming {
  private cursorMs = 0
  private readonly recorded: BootPhaseTiming[] = []

  /**
   * @param now - monotonic millisecond clock measuring from process start;
   * defaults to `performance.now()`.
   */
  constructor(private readonly now: () => number = () => performance.now()) {}

  /**
   * Close the current phase under `phase`.
   * @param phase - stable phase name reported in the summary.
   */
  mark(phase: string): void {
    const atMs = this.now()
    this.recorded.push({ phase, atMs, durationMs: atMs - this.cursorMs })
    this.cursorMs = atMs
  }

  /**
   * @returns the phases recorded so far, in mark order.
   */
  phases(): readonly BootPhaseTiming[] {
    return this.recorded
  }

  /**
   * @returns milliseconds from process start to the last mark.
   */
  get totalMs(): number {
    return this.cursorMs
  }

  /**
   * Render the recorded phases as one line.
   * @returns `phase=<ms>ms` pairs in mark order, followed by `total=<ms>ms`.
   */
  format(): string {
    const parts = this.recorded.map(entry => `${entry.phase}=${entry.durationMs.toFixed(0)}ms`)
    return [...parts, `total=${this.totalMs.toFixed(0)}ms`].join(' ')
  }
}
