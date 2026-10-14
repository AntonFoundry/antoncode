/**
 * Wipe effect, ported from the ttfx Ruby port (`ttfx/effects/wipe.rb`).
 * Every character gets one "wipe" scene: its home (image) color reached
 * from the palette's first color. A SequenceEaser over the wipe
 * direction's groups reveals characters (and hides + rewinds them when
 * the easing runs backward). No RNG is drawn.
 * @module ui-primitives/ttfx/effects/wipe
 */

import type { EngineCtx, FrameCell } from '../scene.ts'
import { Gradient, fromHex } from '../color.ts'
import type { Rgb } from '../color.ts'
import { SequenceEaser } from '../easing.ts'
import type { CharGrouping } from '../grid.ts'
import type { TtfxEffect } from '../effects.ts'

/** Fallback home color when a cell sampled no foreground. */
const FALLBACK_FINAL: Rgb = [255, 255, 255]

/** Wipe reveal: a directional curtain uncovers the mark. */
export class WipeEffect implements TtfxEffect {
  readonly #ctx: EngineCtx
  readonly #direction: CharGrouping
  readonly #delayDefault: number
  readonly #ease: string
  readonly #palette: Rgb[]
  readonly #frames: number
  #easer: SequenceEaser | null = null
  #wipeDelay: number

  /** @param ctx - engine context. @param opts - `wipe_direction`, `wipe_delay`, `wipe_ease`, `wipe_colors`, `wipe_steps`, `wipe_frames`. */
  constructor(ctx: EngineCtx, opts: Record<string, unknown>) {
    this.#ctx = ctx
    this.#direction = (opts.wipe_direction as CharGrouping | undefined) ?? 'diagonal_top_left_to_bottom_right'
    this.#delayDefault = (opts.wipe_delay as number | undefined) ?? 0
    this.#ease = (opts.wipe_ease as string | undefined) ?? 'in_out_circ'
    const paletteHex = (opts.wipe_colors as readonly string[] | undefined) ?? ['833ab4', 'fd1d1d', 'fcb045']
    this.#palette = paletteHex.map(h => fromHex(h) ?? FALLBACK_FINAL)
    this.#frames = (opts.wipe_frames as number | undefined) ?? 3
    this.#wipeDelay = this.#delayDefault
  }

  /** Build the per-character wipe scenes over the grouped canvas. */
  build(): void {
    const ctx = this.#ctx
    const cv = ctx.canvas
    this.#easer = new SequenceEaser(cv.groupedIds(this.#direction), this.#ease, 100)
    for (const id of cv.orderedIds()) {
      const a = ctx.anim(id)
      const first = Gradient.build(this.#palette, [12], false, false).spectrum[0] as Rgb
      const final = a.homeFg ?? FALLBACK_FINAL
      ctx.newScene(id, 'wipe')
      const wg = Gradient.build([first, final], [12], false, false)
      ctx.applyGradient(id, 'wipe', [a.inputSym], this.#frames, wg.spectrum)
      ctx.addFrame(id, 'wipe', a.inputSym, this.#frames, a.homeFg)
    }
  }

  /** One tick; null when the wipe groups and active scenes drained. */
  nextFrame(): FrameCell[] | null {
    const ctx = this.#ctx
    const easer = this.#easer as SequenceEaser
    if (easer.complete && ctx.activeEmpty) return null
    if (this.#wipeDelay === 0) {
      const [added, removed] = easer.step()
      for (const group of added) {
        for (const id of group) {
          ctx.activateScene(id, 'wipe')
          ctx.setVisible(id, true)
          ctx.activeInclude(id)
        }
      }
      for (const group of removed) {
        for (const id of group) {
          ctx.deactivateScene(id)
          ctx.resetScene(id, 'wipe')
          ctx.setVisible(id, false)
        }
      }
      this.#wipeDelay = this.#delayDefault
    } else {
      this.#wipeDelay -= 1
    }
    ctx.update()
    return ctx.frameCells()
  }
}
