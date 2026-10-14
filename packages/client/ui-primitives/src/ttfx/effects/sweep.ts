/**
 * Sweep effect, ported from the ttfx Ruby port (`ttfx/effects/sweep.rb`).
 * A first easer sweep reveals characters uncolored (gray shimmer into a
 * grayscale pass); the easer then re-runs over the second direction
 * coloring them from the palette into their home (image) color. Operates
 * over input + fill characters.
 * @module ui-primitives/ttfx/effects/sweep
 */

import type { EngineCtx, FrameCell } from '../scene.ts'
import { Gradient, fromHex } from '../color.ts'
import type { Rgb } from '../color.ts'
import { SequenceEaser } from '../easing.ts'
import type { CharGrouping } from '../grid.ts'
import type { TtfxEffect } from '../effects.ts'

/** Gray shimmer palette. */
const GRAYS: readonly string[] = ['A0A0A0', '808080', '404040', '202020', '101010']
/** Default sweep glyphs. */
const DEFAULT_SYMBOLS = ['█', '▓', '▒', '░']
/** Fallback home color when a cell sampled no foreground. */
const FALLBACK_FINAL: Rgb = [255, 255, 255]

/** Sweep reveal: a scanner line finds the mark, a second pass colors it. */
export class SweepEffect implements TtfxEffect {
  readonly #ctx: EngineCtx
  readonly #symbols: readonly string[]
  readonly #firstDirection: CharGrouping
  readonly #secondDirection: CharGrouping
  readonly #palette: Rgb[]
  #easer: SequenceEaser | null = null
  #secondGroups: number[][] = []
  #firstPhase = true
  #complete = false

  /**
   * @param ctx - engine context.
   * @param opts - `sweep_symbols`, `first_sweep_direction`,
   *   `second_sweep_direction`, `sweep_colors`, and `sweep_steps`.
   */
  constructor(ctx: EngineCtx, opts: Record<string, unknown>) {
    this.#ctx = ctx
    this.#symbols = (opts.sweep_symbols as readonly string[] | undefined) ?? DEFAULT_SYMBOLS
    this.#firstDirection = (opts.first_sweep_direction as CharGrouping | undefined) ?? 'column_right_to_left'
    this.#secondDirection = (opts.second_sweep_direction as CharGrouping | undefined) ?? 'column_left_to_right'
    const paletteHex = (opts.sweep_colors as readonly string[] | undefined) ?? ['8A008A', '00D1FF', 'ffffff']
    this.#palette = paletteHex.map(h => fromHex(h) ?? FALLBACK_FINAL)
  }

  /** Build shimmer scenes for every kept + fill character. */
  build(): void {
    const ctx = this.#ctx
    const cv = ctx.canvas
    const grad = Gradient.build(this.#palette, [8], false, false)
    /* v8 ignore next -- each entry in the fixed GRAYS palette is a valid six-digit hex color. */
    const grays = GRAYS.map(h => fromHex(h) ?? FALLBACK_FINAL)
    const gray80: Rgb = [128, 128, 128]
    const black: Rgb = [0, 0, 0]
    const all = cv.kept
    for (const id of all) {
      const a = ctx.anim(id)
      ctx.newScene(id, 'initial_sweep')
      for (const sym of this.#symbols) ctx.addFrame(id, 'initial_sweep', sym, 5, ctx.rng.choice(grays))
      ctx.addFrame(id, 'initial_sweep', a.inputSym, 1, gray80)
      ctx.newScene(id, 'second_sweep')
      for (const sym of this.#symbols) ctx.addFrame(id, 'second_sweep', sym, 5, ctx.rng.choice(grad.spectrum))
      /* v8 ignore next -- the sweep group is built from cv.kept, which contains no fill characters. */
      const fcol: Rgb | null = a.isFill ? black : a.homeFg
      ctx.addFrame(id, 'second_sweep', a.inputSym, 1, fcol)
    }
    const firstGroups = cv.groupedIds(this.#firstDirection, all)
    this.#easer = new SequenceEaser(firstGroups, 'in_out_circ', 100)
    this.#secondGroups = cv.groupedIds(this.#secondDirection, all)
  }

  /** One tick; null when both sweeps drained. */
  nextFrame(): FrameCell[] | null {
    const ctx = this.#ctx
    if (ctx.activeEmpty && this.#complete) return null
    const easer = this.#easer as SequenceEaser
    const [added] = easer.step()
    for (const group of added) {
      for (const id of group) {
        if (this.#firstPhase) {
          ctx.setVisible(id, true)
          ctx.activateScene(id, 'initial_sweep')
        } else {
          ctx.activateScene(id, 'second_sweep')
        }
        ctx.activeInclude(id)
      }
    }
    if (easer.complete && this.#firstPhase) {
      easer.resequence(this.#secondGroups)
      this.#firstPhase = false
    } else if (easer.complete) {
      this.#complete = true
    }
    ctx.update()
    return ctx.frameCells()
  }
}
