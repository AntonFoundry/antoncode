/**
 * Scattered effect, ported from the ttfx Ruby port
 * (`ttfx/effects/scattered.rb`). Characters start at random canvas
 * positions and travel home along eased paths while a distance-synced
 * gradient scene cross-fades them from the palette start into their home
 * (image) color; a short hold opens the animation.
 * @module ui-primitives/ttfx/effects/scattered
 */

import type { EngineCtx, FrameCell } from '../scene.ts'
import { Gradient } from '../color.ts'
import type { Rgb } from '../color.ts'
import type { TtfxEffect } from '../effects.ts'

/** Fallback home color when a cell sampled no foreground. */
const FALLBACK_FINAL: Rgb = [255, 255, 255]

/** Scattered reveal: the mark assembles from random scatter positions. */
export class ScatteredEffect implements TtfxEffect {
  readonly #ctx: EngineCtx
  readonly #speed: number
  readonly #ease: string
  readonly #frames: number
  readonly #holdTicks: number
  #hold = 0

  /** @param ctx - engine context. @param opts - `movement_speed`, `movement_easing`, `final_gradient_frames`, `hold_ticks`. */
  constructor(ctx: EngineCtx, opts: Record<string, unknown>) {
    this.#ctx = ctx
    this.#speed = (opts.movement_speed as number | undefined) ?? 0.5
    this.#ease = (opts.movement_easing as string | undefined) ?? 'in_out_back'
    this.#frames = (opts.final_gradient_frames as number | undefined) ?? 9
    this.#holdTicks = (opts.hold_ticks as number | undefined) ?? 25
  }

  /** Scatter every character to a random start with a path home. */
  build(): void {
    const ctx = this.#ctx
    const cv = ctx.canvas
    const startColor: Rgb = [176, 196, 222]
    for (const id of cv.orderedIds()) {
      const a = ctx.anim(id)
      const final = a.homeFg ?? FALLBACK_FINAL
      const start = cv.right < 2 || cv.top < 2 ? [1, 1] as [number, number] : cv.randomCoord(ctx.rng, false, false)
      ctx.motionSetCoordinate(id, start[0], start[1])
      ctx.motionNewPath(id, `path_${id}`, this.#speed, this.#ease, 0, false)
      ctx.motionAddWaypoint(id, `path_${id}`, a.inputCol, a.inputRow)
      ctx.registerEvent(id, 'path_activated', `path_${id}`, { type: 'layer', layer: 1 })
      ctx.registerEvent(id, 'path_complete', `path_${id}`, { type: 'layer', layer: 0 })
      ctx.motionActivatePath(id, `path_${id}`)
      ctx.setVisible(id, true)
      ctx.newSceneSynced(id, `grad_${id}`, 'distance')
      const cg = Gradient.withSteps([startColor, final], 10, false)
      ctx.applyGradient(id, `grad_${id}`, [a.inputSym], this.#frames, cg.spectrum)
      ctx.addFrame(id, `grad_${id}`, a.inputSym, this.#frames, a.homeFg)
      ctx.activateScene(id, `grad_${id}`)
      ctx.activeInclude(id)
    }
    this.#hold = this.#holdTicks
  }

  /** One tick; null when every character settled home. */
  nextFrame(): FrameCell[] | null {
    const ctx = this.#ctx
    if (!ctx.activeEmpty) {
      if (this.#hold !== 0) {
        this.#hold -= 1
        return ctx.frameCells()
      }
      ctx.update()
      return ctx.frameCells()
    }
    return null
  }
}
