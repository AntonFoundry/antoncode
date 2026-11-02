/**
 * Unstable effect, ported from the ttfx Ruby port
 * (`ttfx/effects/remaining.rb` UnstableEffect). The jumbled layout rumbles,
 * bursts to the edges, then reassembles home while cross-fading from the
 * burst color into each character's home (image) color.
 * @module ui-primitives/ttfx/effects/unstable
 */

import type { EngineCtx, FrameCell, MotionPath } from '../scene.ts'
import { Gradient, fromHex } from '../color.ts'
import type { Rgb } from '../color.ts'
import type { TtfxEffect } from '../effects.ts'

/** Burst accent color. */
const BURST: Rgb = fromHex('ff9200') as Rgb
/** Fallback home color when a cell sampled no foreground. */
const FALLBACK_FINAL: Rgb = [255, 255, 255]

/** Unstable reveal: the mark rumbles, explodes to the edges, reassembles. */
export class UnstableEffect implements TtfxEffect {
  readonly #ctx: EngineCtx
  readonly #ids: number[] = []
  readonly #jumbled = new Map<number, [number, number]>()
  readonly #explodeSpeed: number
  readonly #explodeEase: string
  readonly #reassembleSpeed: number
  readonly #reassembleEase: string
  readonly #rumbleTicks: number
  readonly #holdTicks: number
  #phase: 'rumble' | 'explode' | 'settle' | 'done' = 'rumble'
  #ticks = 0
  #hold = 0
  #rumbleDelay: number

  /**
   * @param ctx - engine context.
   * @param opts - `explosion_speed`, `explosion_ease`, `reassembly_speed`,
   *   `reassembly_ease`, `rumble_ticks`, `rumble_delay`, and `hold_ticks`.
   */
  constructor(ctx: EngineCtx, opts: Record<string, unknown>) {
    this.#ctx = ctx
    this.#explodeSpeed = (opts.explosion_speed as number | undefined) ?? 1.0
    this.#explodeEase = (opts.explosion_ease as string | undefined) ?? 'out_expo'
    this.#reassembleSpeed = (opts.reassembly_speed as number | undefined) ?? 1.0
    this.#reassembleEase = (opts.reassembly_ease as string | undefined) ?? 'out_expo'
    this.#rumbleTicks = (opts.rumble_ticks as number | undefined) ?? 150
    this.#rumbleDelay = (opts.rumble_delay as number | undefined) ?? 18
    this.#holdTicks = (opts.hold_ticks as number | undefined) ?? 30
  }

  /** Jumble every character to a random home, rumble, and stage bursts. */
  build(): void {
    const ctx = this.#ctx
    const cv = ctx.canvas
    this.#ids.push(...cv.orderedIds())
    const coords = this.#ids.map((id) => {
      const a = ctx.anim(id)
      return [a.inputCol, a.inputRow] as [number, number]
    })
    for (const id of this.#ids) {
      const base = ctx.anim(id).homeFg ?? FALLBACK_FINAL
      const edge = ctx.rng.randint(0, 3)
      let target: [number, number]
      if (edge === 0) target = [cv.left, ctx.rng.randint(cv.bottom, cv.top)]
      else if (edge === 1) target = [cv.right, ctx.rng.randint(cv.bottom, cv.top)]
      else if (edge === 2) target = [ctx.rng.randint(cv.left, cv.right), cv.bottom]
      else target = [ctx.rng.randint(cv.left, cv.right), cv.top]
      const home = coords.splice(ctx.rng.randint(0, coords.length - 1), 1)[0] as [number, number]
      this.#jumbled.set(id, home)
      const a = ctx.anim(id)
      ctx.motionSetCoordinate(id, home[0], home[1])
      ctx.newScene(id, 'rumble')
      for (const color of Gradient.withSteps([base, BURST], 12, false).spectrum) {
        ctx.addFrame(id, 'rumble', a.inputSym, 10, color)
      }
      ctx.newScene(id, 'settle')
      for (const color of Gradient.withSteps([BURST, base], 12, false).spectrum) {
        ctx.addFrame(id, 'settle', a.inputSym, 3, color)
      }
      ctx.addFrame(id, 'settle', a.inputSym, 3, a.homeFg)
      ctx.motionNewPath(id, 'explode', this.#explodeSpeed, this.#explodeEase, 0, false)
      ctx.motionAddWaypoint(id, 'explode', target[0], target[1])
      ctx.motionNewPath(id, 'reassemble', this.#reassembleSpeed, this.#reassembleEase, 0, false)
      ctx.motionAddWaypoint(id, 'reassemble', a.inputCol, a.inputRow)
      ctx.setAppearance(id, a.inputSym, a.homeFg)
      ctx.setVisible(id, true)
      ctx.activateScene(id, 'rumble')
    }
    this.#hold = this.#holdTicks
    this.#rumbleDelay = this.#rumbleDelay
  }

  /** One tick; null once the reassembly drained. */
  nextFrame(): FrameCell[] | null {
    const ctx = this.#ctx
    if (this.#phase === 'rumble') {
      if (this.#ticks < this.#rumbleTicks) {
        if (this.#ticks > 30 && this.#ticks % this.#rumbleDelay === 0) {
          const dr = ctx.rng.choice([-1, 0, 1])
          const dc = ctx.rng.choice([-1, 0, 1])
          for (const id of this.#ids) {
            const a = ctx.anim(id)
            ctx.motionSetCoordinate(id, a.curCol + dc, a.curRow + dr)
          }
          for (const id of this.#ids) ctx.stepAnimation(id)
          const frame = ctx.frameCells()
          for (const id of this.#ids) {
            const p = this.#jumbled.get(id) as [number, number]
            ctx.motionSetCoordinate(id, p[0], p[1])
          }
          this.#rumbleDelay = Math.max(1, this.#rumbleDelay - 1)
          this.#ticks += 1
          return frame
        }
        for (const id of this.#ids) ctx.stepAnimation(id)
        this.#ticks += 1
        return ctx.frameCells()
      }
      this.#phase = 'explode'
      for (const id of this.#ids) {
        ctx.motionActivatePath(id, 'explode')
        ctx.activeInclude(id)
      }
    }
    if (this.#phase === 'explode') {
      if (!ctx.activeEmpty) {
        ctx.update()
        ctx.active = ctx.active.filter((id) => {
          const a = ctx.anim(id)
          const last = (a.paths.get('explode') as MotionPath).waypoints.at(-1) as [number, number, unknown]
          return !(a.curCol === last[0] && a.curRow === last[1])
        })
        return ctx.frameCells()
      }
      if (this.#hold > 0) {
        this.#hold -= 1
        return ctx.frameCells()
      }
      this.#phase = 'settle'
      for (const id of this.#ids) {
        ctx.activateScene(id, 'settle')
        ctx.motionActivatePath(id, 'reassemble')
        ctx.activeInclude(id)
      }
    }
    if (this.#phase === 'settle') {
      if (!ctx.activeEmpty) {
        ctx.update()
        ctx.active = ctx.active.filter((id) => {
          const a = ctx.anim(id)
          const last = (a.paths.get('reassemble') as MotionPath).waypoints.at(-1) as [number, number, unknown]
          return !(a.curCol === last[0] && a.curRow === last[1] && a.active === null)
        })
        return ctx.frameCells()
      }
      this.#phase = 'done'
    }
    return null
  }
}
