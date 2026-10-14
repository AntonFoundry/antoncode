/**
 * Waves effect, ported from the ttfx Ruby port (`ttfx/effects/waves.rb`).
 * A wave gradient travels across grouped characters (eased); each character
 * plays wave_count passes of the wave symbols, then settles into its home
 * (image) color. Groups are released one per tick in the wave direction.
 * @module ui-primitives/ttfx/effects/waves
 */

import type { EngineCtx, FrameCell } from '../scene.ts'
import { Gradient, fromHex } from '../color.ts'
import type { Rgb } from '../color.ts'
import type { TtfxEffect } from '../effects.ts'
import type { CharGrouping } from '../grid.ts'

/** Default wave glyphs (eighth-blocks sweeping up and back down). */
const DEFAULT_SYMBOLS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▂', '▁']
/** Default wave gradient. */
const DEFAULT_WAVE_STOPS: readonly string[] = ['f0ff65', 'ffb102', '31a0d4', 'ffb102', 'f0ff65']
/** Fallback home color when a cell sampled no foreground. */
const FALLBACK_FINAL: Rgb = [255, 255, 255]

/** Waves reveal: gradient waves deposit the mark as they pass. */
export class WavesEffect implements TtfxEffect {
  readonly #ctx: EngineCtx
  readonly #waveSymbols: readonly string[]
  readonly #waveGradient: Rgb[]
  readonly #waveSteps: readonly number[]
  readonly #waveCount: number
  readonly #waveLength: number
  readonly #waveDirection: CharGrouping
  readonly #waveEase: string
  readonly #finalSteps: readonly number[]
  readonly #finalFrames: number
  readonly #pending: number[][] = []

  /**
   * @param ctx - engine context.
   * @param opts - `wave_symbols`, `wave_gradient_stops`, `wave_gradient_steps`,
   *   `wave_count`, `wave_length`, `wave_direction`, `wave_easing`,
   *   `final_gradient_steps`, and `final_frames`.
   */
  constructor(ctx: EngineCtx, opts: Record<string, unknown>) {
    this.#ctx = ctx
    this.#waveSymbols = (opts.wave_symbols as readonly string[] | undefined) ?? DEFAULT_SYMBOLS
    const waveStops = (opts.wave_gradient_stops as readonly string[] | undefined) ?? DEFAULT_WAVE_STOPS
    this.#waveGradient = waveStops.map(h => fromHex(h) ?? FALLBACK_FINAL)
    this.#waveSteps = (opts.wave_gradient_steps as readonly number[] | undefined) ?? [6]
    this.#waveCount = (opts.wave_count as number | undefined) ?? 7
    this.#waveLength = (opts.wave_length as number | undefined) ?? 2
    this.#waveDirection = (opts.wave_direction as CharGrouping | undefined) ?? 'column_left_to_right'
    this.#waveEase = (opts.wave_easing as string | undefined) ?? 'in_out_sine'
    this.#finalSteps = (opts.final_gradient_steps as readonly number[] | undefined) ?? [12]
    this.#finalFrames = (opts.final_frames as number | undefined) ?? 10
  }

  /** Build eased wave scenes and settle gradients per character. */
  build(): void {
    const ctx = this.#ctx
    const cv = ctx.canvas
    const wgrad = Gradient.build(this.#waveGradient, this.#waveSteps, false, false)
    const order = cv.orderedIds()
    for (const id of order) {
      const a = ctx.anim(id)
      const final = a.homeFg ?? FALLBACK_FINAL
      ctx.newSceneEased(id, `wave_${id}`, this.#waveEase)
      for (let i = 0; i < this.#waveCount; i += 1) {
        ctx.applyGradient(id, `wave_${id}`, this.#waveSymbols, this.#waveLength, wgrad.spectrum)
      }
      ctx.newScene(id, `final_${id}`)
      const fgrad = Gradient.build([wgrad.spectrum[wgrad.spectrum.length - 1] as Rgb, final], this.#finalSteps, false, false)
      for (const c of fgrad.spectrum) ctx.addFrame(id, `final_${id}`, a.inputSym, this.#finalFrames, c)
      ctx.addFrame(id, `final_${id}`, a.inputSym, this.#finalFrames, a.homeFg)
      ctx.registerEvent(id, 'scene_complete', `wave_${id}`, { type: 'scene', name: `final_${id}` })
      ctx.activateScene(id, `wave_${id}`)
    }
    this.#pending.push(...cv.groupedIds(this.#waveDirection))
  }

  /** One tick; null when the last wave group settled. */
  nextFrame(): FrameCell[] | null {
    const ctx = this.#ctx
    if (this.#pending.length > 0 || !ctx.activeEmpty) {
      if (this.#pending.length > 0) {
        const group = this.#pending.shift() as number[]
        for (const id of group) {
          ctx.setVisible(id, true)
          ctx.activeInclude(id)
        }
      }
      ctx.update()
      return ctx.frameCells()
    }
    return null
  }
}
