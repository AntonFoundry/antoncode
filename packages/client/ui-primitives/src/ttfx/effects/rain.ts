/**
 * Rain effect, ported from the ttfx Ruby port (`ttfx/effects/rain.rb`).
 * Raindrops fall from the top of the canvas along eased paths; on arrival
 * each character cross-fades from its raindrop color to its home (image)
 * color. Characters are released row by row (lowest row first) with a
 * random 1-2 activations per tick at random pending positions.
 * @module ui-primitives/ttfx/effects/rain
 */

import type { EngineCtx, FrameCell } from '../scene.ts'
import { Gradient, fromHex } from '../color.ts'
import type { Rgb } from '../color.ts'
import type { TtfxEffect } from '../effects.ts'

/** Default rain blues. */
const DEFAULT_RAIN: readonly string[] = ['00315C', '004C8F', '0075DB', '3F91D9', '78B9F2', '9AC8F5', 'B8D8F8', 'E3EFFC']
/** Default raindrop glyphs. */
const DEFAULT_SYMBOLS = ['o', '.', ',', '*', '|']
/** Fallback home color when a cell sampled no foreground. */
const FALLBACK_FINAL: Rgb = [255, 255, 255]

/** Rain reveal: drops fall from the top and fade into the mark. */
export class RainEffect implements TtfxEffect {
  readonly #ctx: EngineCtx
  readonly #rainColors: Rgb[]
  readonly #rainSymbols: readonly string[]
  readonly #speedRange: readonly [number, number]
  readonly #activationsPerTick: readonly [number, number]
  readonly #ease: string
  #pending: number[] = []
  readonly #groupByRow = new Map<number, number[]>()

  /**
   * @param ctx - engine context.
   * @param opts - `rain_colors`, `rain_symbols`, `movement_speed`,
   *   `activations_per_tick`, and `movement_easing`.
   */
  constructor(ctx: EngineCtx, opts: Record<string, unknown>) {
    this.#ctx = ctx
    const rainHex = (opts.rain_colors as readonly string[] | undefined) ?? DEFAULT_RAIN
    this.#rainColors = rainHex.map(h => fromHex(h) ?? FALLBACK_FINAL)
    this.#rainSymbols = (opts.rain_symbols as readonly string[] | undefined) ?? DEFAULT_SYMBOLS
    this.#speedRange = (opts.movement_speed as readonly [number, number] | undefined) ?? [0.33, 0.57]
    this.#activationsPerTick = (opts.activations_per_tick as readonly [number, number] | undefined) ?? [1, 2]
    this.#ease = (opts.movement_easing as string | undefined) ?? 'in_quart'
  }

  /** Build per-character rain + fade scenes and falling paths. */
  build(): void {
    const ctx = this.#ctx
    const cv = ctx.canvas
    const order = cv.orderedIds()
    const top = cv.top
    for (const id of order) {
      const a = ctx.anim(id)
      const final = a.homeFg ?? FALLBACK_FINAL
      const rainColor = ctx.rng.choice(this.#rainColors)
      const rainSym = ctx.rng.choice(this.#rainSymbols)
      ctx.newScene(id, `rain_${id}`)
      ctx.addFrame(id, `rain_${id}`, rainSym, 1, rainColor)
      ctx.newScene(id, `fade_${id}`)
      const fg = Gradient.withSteps([rainColor, final], 7, false)
      ctx.applyGradient(id, `fade_${id}`, [a.inputSym], 3, fg.spectrum)
      ctx.addFrame(id, `fade_${id}`, a.inputSym, 3, a.homeFg)
      ctx.activateScene(id, `rain_${id}`)
      const speed = ctx.rng.uniform(this.#speedRange[0], this.#speedRange[1])
      ctx.motionSetCoordinate(id, a.inputCol, top)
      ctx.motionNewPath(id, `path_${id}`, speed, this.#ease, 0, false)
      ctx.motionAddWaypoint(id, `path_${id}`, a.inputCol, a.inputRow)
      ctx.registerEvent(id, 'path_complete', `path_${id}`, { type: 'scene', name: `fade_${id}` })
      ctx.motionActivatePath(id, `path_${id}`)
      this.#pending.push(id)
    }
    for (const id of this.#pending) {
      const r = ctx.anim(id).inputRow
      const list = this.#groupByRow.get(r)
      if (list === undefined) this.#groupByRow.set(r, [id])
      else list.push(id)
    }
    this.#pending = []
  }

  /** One tick; null when every drop landed and faded. */
  nextFrame(): FrameCell[] | null {
    const ctx = this.#ctx
    if (this.#groupByRow.size === 0 && ctx.activeEmpty && this.#pending.length === 0) return null
    if (this.#pending.length === 0 && this.#groupByRow.size > 0) {
      let minRow: number | null = null
      for (const r of this.#groupByRow.keys()) {
        if (minRow === null || r < minRow) minRow = r
      }
      this.#pending = this.#groupByRow.get(minRow as number) as number[]
      this.#groupByRow.delete(minRow as number)
    }
    if (this.#pending.length > 0) {
      const n = ctx.rng.randint(this.#activationsPerTick[0], this.#activationsPerTick[1])
      for (let i = 0; i < n; i += 1) {
        if (this.#pending.length === 0) break
        const idx = ctx.rng.randint(0, this.#pending.length - 1)
        const cid = this.#pending.splice(idx, 1)[0] as number
        ctx.setVisible(cid, true)
        ctx.activeInclude(cid)
      }
    }
    ctx.update()
    return ctx.frameCells()
  }
}
