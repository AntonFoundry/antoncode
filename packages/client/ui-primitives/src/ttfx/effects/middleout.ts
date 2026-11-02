/**
 * Middleout effect, ported from the ttfx Ruby port
 * (`ttfx/effects/middleout.rb`). Characters start at the canvas center,
 * expand along a center line, then run a second "full" path home while
 * cross-fading from the starting color into their home (image) color.
 * Fully deterministic (no RNG draws).
 * @module ui-primitives/ttfx/effects/middleout
 */

import type { EngineCtx, FrameCell } from '../scene.ts'
import { Gradient } from '../color.ts'
import type { Rgb } from '../color.ts'
import type { TtfxEffect } from '../effects.ts'

/** Fallback home color when a cell sampled no foreground. */
const FALLBACK_FINAL: Rgb = [255, 255, 255]

/** Middleout reveal: the mark unfolds along its center line. */
export class MiddleoutEffect implements TtfxEffect {
  readonly #ctx: EngineCtx
  readonly #starting: Rgb
  readonly #direction: 'vertical' | 'horizontal'
  readonly #centerSpeed: number
  readonly #fullSpeed: number
  readonly #centerEase: string
  readonly #fullEase: string
  #phase: 'center' | 'full' = 'center'

  /**
   * @param ctx - engine context.
   * @param opts - `starting_color`, `expand_direction`, `center_movement_speed`,
   *   `full_movement_speed`, `center_easing`, and `full_easing`.
   */
  constructor(ctx: EngineCtx, opts: Record<string, unknown>) {
    this.#ctx = ctx
    this.#starting = (opts.starting_color as Rgb | undefined) ?? [255, 255, 255]
    this.#direction = (opts.expand_direction as 'vertical' | 'horizontal' | undefined) ?? 'vertical'
    this.#centerSpeed = (opts.center_movement_speed as number | undefined) ?? 0.6
    this.#fullSpeed = (opts.full_movement_speed as number | undefined) ?? 0.6
    this.#centerEase = (opts.center_easing as string | undefined) ?? 'in_out_sine'
    this.#fullEase = (opts.full_easing as string | undefined) ?? 'in_out_sine'
  }

  /** Collapse to the center line, then stage the full path home. */
  build(): void {
    const ctx = this.#ctx
    const cv = ctx.canvas
    const cc = cv.centerColumn
    const cr = cv.centerRow
    for (const id of cv.orderedIds()) {
      const a = ctx.anim(id)
      const final = a.homeFg ?? FALLBACK_FINAL
      ctx.motionSetCoordinate(id, cc, cr)
      let midCol: number
      let midRow: number
      if (this.#direction === 'vertical') {
        midCol = a.inputCol
        midRow = cr
      } else {
        midCol = cc
        midRow = a.inputRow
      }
      const cpath = ctx.motionNewPath(id, '', this.#centerSpeed, this.#centerEase, 0, false)
      ctx.motionAddWaypoint(id, cpath, midCol, midRow)
      ctx.motionNewPath(id, 'full', this.#fullSpeed, this.#fullEase, 0, false)
      ctx.motionAddWaypoint(id, 'full', a.inputCol, a.inputRow)
      ctx.newScene(id, 'full')
      const fg = Gradient.withSteps([this.#starting, final], 10, false)
      ctx.applyGradient(id, 'full', [a.inputSym], 6, fg.spectrum)
      ctx.addFrame(id, 'full', a.inputSym, 6, a.homeFg)
      ctx.motionActivatePath(id, cpath)
      ctx.setAppearance(id, a.inputSym, this.#starting)
      ctx.setVisible(id, true)
      ctx.activeInclude(id)
    }
  }

  /** One tick; null when the full phase drained. */
  nextFrame(): FrameCell[] | null {
    const ctx = this.#ctx
    if (this.#phase === 'center' && ctx.activeEmpty) {
      this.#phase = 'full'
      const ids = ctx.canvas.orderedIds().sort((a, b) => a - b)
      ctx.activeClear()
      for (const id of ids) ctx.activeInclude(id)
      for (const id of ids) {
        ctx.motionActivatePath(id, 'full')
        ctx.activateScene(id, 'full')
      }
    }
    if (!ctx.activeEmpty) {
      ctx.update()
      return ctx.frameCells()
    }
    return null
  }
}
