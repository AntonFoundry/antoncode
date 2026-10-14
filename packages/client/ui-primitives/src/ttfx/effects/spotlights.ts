/**
 * Spotlights effect, ported from the ttfx Ruby port
 * (`ttfx/effects/spotlights.rb`). Invisible spotlight movers sweep
 * bezier-chained search paths while characters illuminate by proximity
 * with beam falloff; the spotlights converge on the canvas center and the
 * beam expands to full coverage. Bright/dark base colors come from each
 * character's home (image) color.
 * @module ui-primitives/ttfx/effects/spotlights
 */

import type { EngineCtx, FrameCell } from '../scene.ts'
import { Geometry } from '../scene.ts'
import { adjustBrightness } from '../color.ts'
import type { Rgb } from '../color.ts'
import type { TtfxEffect } from '../effects.ts'

/** Spotlight reveal: searchlights sweep the dark, then flood the mark. */
export class SpotlightsEffect implements TtfxEffect {
  readonly #ctx: EngineCtx
  readonly #widthRatio: number
  readonly #falloff: number
  readonly #searchDefault: number
  readonly #speedRange: readonly [number, number]
  readonly #count: number
  readonly #colorMap = new Map<number, readonly [Rgb | null, Rgb | null]>()
  #spotlights: number[] = []
  #range = 1
  #searchLeft = 0
  #searching = true
  #complete = false
  #finalFramePending = false
  #illuminated: number[] = []

  /**
   * @param ctx - engine context.
   * @param opts - `beam_width_ratio`, `beam_falloff`, `search_duration`,
   *   `search_speed_range`, and `spotlight_count`.
   */
  constructor(ctx: EngineCtx, opts: Record<string, unknown>) {
    this.#ctx = ctx
    this.#widthRatio = (opts.beam_width_ratio as number | undefined) ?? 2.0
    this.#falloff = (opts.beam_falloff as number | undefined) ?? 0.3
    this.#searchDefault = (opts.search_duration as number | undefined) ?? 550
    this.#speedRange = (opts.search_speed_range as readonly [number, number] | undefined) ?? [0.35, 0.75]
    this.#count = (opts.spotlight_count as number | undefined) ?? 3
  }

  /** Undoubled-cell distance between two coordinates. */
  #plainLength(c1col: number, c1row: number, c2col: number, c2row: number): number {
    const dx = c2col - c1col
    const dy = c2row - c1row
    return Math.sqrt(dx * dx + dy * dy)
  }

  /** Rejection-sample a random coordinate at least `minimum` away. */
  #minDistanceCoord(originCol: number, originRow: number, minimum: number): [number, number] {
    for (;;) {
      const c = this.#ctx.canvas.randomCoord(this.#ctx.rng, false, false)
      if (this.#plainLength(originCol, originRow, c[0], c[1]) >= minimum) return c
    }
  }

  /** Create `n` spotlight movers with chained search paths plus a center path. */
  #makeSpotlights(n: number): number[] {
    const ctx = this.#ctx
    const cv = ctx.canvas
    const out: number[] = []
    const minDist = Math.floor(cv.right / 4)
    for (let i = 0; i < n; i += 1) {
      const spawn = cv.randomCoord(ctx.rng, true, false)
      const id = ctx.addCharacter('O', spawn[0], spawn[1])
      out.push(id)
      let last = cv.randomCoord(ctx.rng, false, false)
      const names: string[] = []
      for (let t = 0; t <= 10; t += 1) {
        const target = t === 0 ? last : (last = this.#minDistanceCoord(last[0], last[1], minDist))
        const speed = ctx.rng.uniform(this.#speedRange[0], this.#speedRange[1])
        const pname = String(names.length)
        ctx.motionNewPath(id, pname, speed, 'in_out_quad', 0, false)
        const bc = cv.randomCoord(ctx.rng, true, false)
        ctx.motionAddWaypoint(id, pname, target[0], target[1], [[bc[0], bc[1]]])
        names.push(pname)
      }
      ctx.chainPaths(id, names, true)
      ctx.motionNewPath(id, 'center', 0.5, 'in_out_sine', 0, false)
      ctx.motionAddWaypoint(id, 'center', cv.centerColumn, cv.centerRow)
    }
    return out
  }

  /** Recolor characters by spotlight proximity with beam falloff. */
  #illuminate(range: number): void {
    const ctx = this.#ctx
    const cv = ctx.canvas
    const inRange: number[] = []
    for (const sid of this.#spotlights) {
      const s = ctx.anim(sid)
      for (const cc of Geometry.coordsInCircle(s.curCol, s.curRow, range)) {
        const id = cv.charByCoord(cc[0], cc[1])
        if (id === null) continue
        if (ctx.anim(id).inputSym !== ' ' && !inRange.includes(id)) inRange.push(id)
      }
    }
    for (const id of [...this.#illuminated].sort((a, b) => a - b)) {
      if (inRange.includes(id)) continue
      const a = ctx.anim(id)
      ctx.setAppearance(id, a.inputSym, (this.#colorMap.get(id) as readonly [Rgb, Rgb])[1])
    }
    for (const id of inRange.toSorted((a, b) => a - b)) {
      const a = ctx.anim(id)
      let best: number | null = null
      for (const sid of this.#spotlights) {
        const s = ctx.anim(sid)
        const d = ctx.lineLength(s.curCol, s.curRow, a.inputCol, a.inputRow)
        if (best === null || d < best) best = d
      }
      const [bright] = this.#colorMap.get(id) as readonly [Rgb | null, Rgb | null]
      let color: Rgb | null = bright
      const edge = range * (1 - this.#falloff)
      if (best !== null && best > edge) {
        let factor = 1 - (best - edge) / (range * this.#falloff)
        if (factor < 0.2) factor = 0.2
        color = bright === null ? null : adjustBrightness(bright, factor)
      }
      ctx.setAppearance(id, a.inputSym, color)
    }
    this.#illuminated = inRange
  }

  /** Build the movers, base colors, and beam range; start the search. */
  build(): void {
    const ctx = this.#ctx
    const cv = ctx.canvas
    this.#spotlights = this.#makeSpotlights(this.#count)
    for (const id of cv.orderedIds()) {
      const bright = ctx.anim(id).homeFg
      const dark = bright === null ? null : adjustBrightness(bright, 0.2)
      ctx.setVisible(id, true)
      this.#colorMap.set(id, [bright, dark])
      ctx.setAppearance(id, ctx.anim(id).inputSym, dark)
    }
    const smallest = Math.min(cv.right, cv.top)
    this.#range = Math.min(smallest, Math.max(1, Math.floor(smallest / this.#widthRatio)))
    this.#searchLeft = this.#searchDefault
    this.#searching = true
    this.#complete = false
    this.#finalFramePending = false
    for (const sid of this.#spotlights) {
      ctx.motionActivatePath(sid, '0')
      ctx.activeInclude(sid)
    }
  }

  /** One tick; null when the expanded beam covered the canvas. */
  nextFrame(): FrameCell[] | null {
    const ctx = this.#ctx
    if (this.#complete) {
      if (this.#finalFramePending) {
        this.#finalFramePending = false
        for (const id of ctx.canvas.orderedIds()) {
          const a = ctx.anim(id)
          ctx.setAppearance(id, a.inputSym, a.homeFg)
        }
        return ctx.frameCells()
      }
      return null
    }
    this.#illuminate(this.#range)
    if (this.#searching) {
      this.#searchLeft -= 1
      if (this.#searchLeft === 0) {
        for (const sid of this.#spotlights) ctx.motionActivatePath(sid, 'center')
        this.#searching = false
      }
    }
    const anyActive = this.#spotlights.some(sid => ctx.anim(sid).activePath !== null)
    if (!anyActive) {
      while (this.#spotlights.length > 1) this.#spotlights.pop()
      this.#range += 1
      const cv = ctx.canvas
      const biggest = Math.max(cv.right, cv.top)
      if (this.#range > Math.floor(biggest / 1.5)) {
        this.#complete = true
        this.#finalFramePending = true
      }
    }
    ctx.update()
    return ctx.frameCells()
  }
}
