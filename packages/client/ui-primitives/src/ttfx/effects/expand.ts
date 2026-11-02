/**
 * Expand effect, ported from the ttfx Ruby port (`ttfx/effects/expand.rb`).
 * Characters start at the canvas center and travel home along eased paths
 * while a distance-synced gradient scene cross-fades them from the palette
 * start into their home (image) color. Fully deterministic (no RNG draws).
 * @module ui-primitives/ttfx/effects/expand
 */

import type { EngineCtx, FrameCell } from '../scene.ts'
import { Gradient } from '../color.ts'
import type { Rgb } from '../color.ts'
import type { TtfxEffect } from '../effects.ts'

/** Palette start color for the distance-synced cross-fade. */
const START_COLOR: Rgb = [138, 0, 138]
/** Fallback home color when a cell sampled no foreground. */
const FALLBACK_FINAL: Rgb = [255, 255, 255]

/** Expand reveal: the mark grows outward from a single point. */
export class ExpandEffect implements TtfxEffect {
  readonly #ctx: EngineCtx
  readonly #ease: string
  readonly #speed: number

  /** @param ctx - engine context. @param opts - `expand_easing`, `movement_speed`. */
  constructor(ctx: EngineCtx, opts: Record<string, unknown>) {
    this.#ctx = ctx
    this.#ease = (opts.expand_easing as string | undefined) ?? 'in_out_quart'
    this.#speed = (opts.movement_speed as number | undefined) ?? 0.35
  }

  /** Collapse every character to the center with a path home. */
  build(): void {
    const ctx = this.#ctx
    const cv = ctx.canvas
    const centerCol = cv.centerColumn
    const centerRow = cv.centerRow
    for (const id of cv.orderedIds()) {
      const a = ctx.anim(id)
      const final = a.homeFg ?? FALLBACK_FINAL
      ctx.motionSetCoordinate(id, centerCol, centerRow)
      ctx.motionNewPath(id, `path_${id}`, this.#speed, this.#ease, 0, false)
      ctx.motionAddWaypoint(id, `path_${id}`, a.inputCol, a.inputRow)
      ctx.registerEvent(id, 'path_activated', `path_${id}`, { type: 'layer', layer: 1 })
      ctx.registerEvent(id, 'path_complete', `path_${id}`, { type: 'layer', layer: 0 })
      ctx.motionActivatePath(id, `path_${id}`)
      ctx.setVisible(id, true)
      ctx.activeInclude(id)
      ctx.newSceneSynced(id, `grad_${id}`, 'distance')
      const cg = Gradient.withSteps([START_COLOR, final], 10, false)
      ctx.applyGradient(id, `grad_${id}`, [a.inputSym], 5, cg.spectrum)
      ctx.addFrame(id, `grad_${id}`, a.inputSym, 5, a.homeFg)
      ctx.activateScene(id, `grad_${id}`)
    }
  }

  /** One tick; null when every character expanded home. */
  nextFrame(): FrameCell[] | null {
    const ctx = this.#ctx
    if (!ctx.activeEmpty) {
      ctx.update()
      return ctx.frameCells()
    }
    return null
  }
}
