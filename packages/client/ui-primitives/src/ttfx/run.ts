/**
 * Effect runner: builds a canvas + engine context from a laid-out
 * character grid and steps a named effect frame by frame. Shared by the
 * React component, the deterministic tests, and the Node QA dumps.
 * @module ui-primitives/ttfx/run
 */

import { Canvas } from './grid.ts'
import type { GridCell } from './grid.ts'
import { EngineCtx } from './scene.ts'
import type { FrameCell, EffectCallbackReceiver } from './scene.ts'
import { Rng } from './rng.ts'
import { createEffect } from './effects.ts'
import type { EffectId, TtfxEffect } from './effects.ts'

/** Runner construction options. */
export interface RunnerOptions {
  /** Effect to run. */
  effect: EffectId
  /** Deterministic seed (same seed → same frames). */
  seed: number
  /** Effect-specific options passed through to the effect. */
  opts?: Record<string, unknown>
}

/**
 * One runnable reveal over a laid-out grid. Call {@link RevealRunner.next}
 * once per animation tick until it returns null (animation complete).
 */
export class RevealRunner {
  readonly ctx: EngineCtx
  readonly #effect: TtfxEffect

  /**
   * @param grid - laid-out input grid, top line first (canvas rows/columns
   *   are derived from it).
   * @param options - see {@link RunnerOptions}.
   */
  constructor(grid: readonly (readonly GridCell[])[], options: RunnerOptions) {
    const cols = grid.reduce((w, line) => Math.max(w, line.length), 0)
    const canvas = new Canvas(grid.length, cols, grid)
    const rng = new Rng(options.seed)
    this.ctx = new EngineCtx(canvas, rng)
    this.#effect = createEffect(options.effect, this.ctx, options.opts ?? {})
    this.#effect.build()
  }

  /**
   * Advance one tick.
   * @returns the rendered cells, or null when the animation completed.
   */
  next(): FrameCell[] | null {
    return this.#effect.nextFrame()
  }
}

/**
 * Run an effect to completion (or a frame cap).
 * @param grid - laid-out input grid, top line first.
 * @param options - runner options.
 * @param maxFrames - safety cap on collected frames (≥ 1).
 * @returns every rendered frame until the effect completed or capped.
 */
export function runEffect(
  grid: readonly (readonly GridCell[])[],
  options: RunnerOptions,
  maxFrames: number,
): FrameCell[][] {
  const runner = new RevealRunner(grid, options)
  const frames: FrameCell[][] = []
  for (let i = 0; i < maxFrames; i += 1) {
    const cells = runner.next()
    if (cells === null) break
    frames.push(cells)
  }
  return frames
}

/** Re-export for callers that need the callback receiver type. */
export type { EffectCallbackReceiver }
