/**
 * Burn effect, ported from the ttfx Ruby port (`ttfx/effects/burn.rb`).
 * A Prim's-ordered ignition front burns each character through fire colors
 * into its home (image) color; burning characters puff recycled smoke
 * particles that rise and fade. Particle emission/reclaim runs through
 * callbacks.
 * @module ui-primitives/ttfx/effects/burn
 */

import type { EngineCtx, FrameCell } from '../scene.ts'
import { Gradient, fromHex } from '../color.ts'
import type { Rgb } from '../color.ts'
import { PrimsSimple } from '../spanning.ts'
import { ParticlePool } from '../particles.ts'
import type { TtfxEffect } from '../effects.ts'

/** Glyphs a cell cycles through while burning. */
const BURN_ORDER = ['\'', '.', '▖', '▙', '█', '▜', '▀', '▝', '.']
/** Smoke particle glyphs. */
const SMOKE_SYMBOLS = ['.', ',', '\'', '`', '#', '*']
/** Default fire ramp. */
const DEFAULT_BURN: readonly string[] = ['ffffff', 'fff75d', 'fe650d', '8A003C', '510100']
/** Fallback home color when a cell sampled no foreground. */
const FALLBACK_FINAL: Rgb = [255, 255, 255]

/** Burn reveal: an ignition front rises through the mark with smoke. */
export class BurnEffect implements TtfxEffect {
  readonly #ctx: EngineCtx
  readonly #starting: Rgb
  readonly #burnColors: Rgb[]
  readonly #smokeChance: number
  readonly #smokePoolSize: number
  readonly #pool: ParticlePool
  readonly #linkOrder: number[] = []

  /** @param ctx - engine context. @param opts - `starting_color`, `burn_colors`, `smoke_chance`, `smoke_pool`. */
  constructor(ctx: EngineCtx, opts: Record<string, unknown>) {
    this.#ctx = ctx
    this.#starting = fromHex((opts.starting_color as string | undefined) ?? '837373') ?? FALLBACK_FINAL
    const burnHex = (opts.burn_colors as readonly string[] | undefined) ?? DEFAULT_BURN
    this.#burnColors = burnHex.map(h => fromHex(h) ?? FALLBACK_FINAL)
    this.#smokeChance = (opts.smoke_chance as number | undefined) ?? 0.5
    this.#smokePoolSize = (opts.smoke_pool as number | undefined) ?? 800
    this.#pool = new ParticlePool(SMOKE_SYMBOLS, this.#smokePoolSize, [0, 0])
  }

  /** Initialize one pooled smoke character (gray → white fade scene). */
  #initSmoke(id: number): void {
    const ctx = this.#ctx
    const g = Gradient.withSteps([[80, 79, 79], [199, 199, 199]], 9, false)
    ctx.newScene(id, 'smoke')
    for (const c of g.spectrum) ctx.addFrame(id, 'smoke', ctx.anim(id).inputSym, 10, c)
    ctx.anim(id).layer = 2
  }

  #emitSmoke(originCol: number, originRow: number): void {
    const ctx = this.#ctx
    if (ctx.rng.random() > this.#smokeChance) return
    const id = this.#pool.acquire(ctx)
    if (id === null) return
    ctx.motionSetCoordinate(id, originCol, originRow)
    const pname = ctx.motionNewPath(id, '', 0.5, null, 0, false)
    const top = ctx.canvas.top
    ctx.motionAddWaypoint(id, pname, ctx.rng.randint(originCol - 4, originCol + 4), top + 1)
    ctx.motionActivatePath(id, pname)
    ctx.activateScene(id, 'smoke')
    ctx.registerEvent(id, 'scene_complete', 'smoke', { type: 'callback', id: 1 })
    ctx.setVisible(id, true)
    ctx.activeInclude(id)
  }

  /** {@inheritdoc} */
  onCallback(ctx: EngineCtx, id: number, cbid: number): void {
    if (cbid === 0) {
      const a = ctx.anim(id)
      this.#emitSmoke(a.inputCol, a.inputRow)
    } else if (cbid === 1) {
      this.#pool.reclaim(ctx, id, true, true)
    }
  }

  /** Build the Prim's ignition order, per-character burn + final scenes. */
  build(): void {
    const ctx = this.#ctx
    const algo = new PrimsSimple(ctx, null, true)
    this.#pool.preallocate(ctx, this.#smokePoolSize)
    for (const pid of this.#pool.particles) this.#initSmoke(pid)
    const order = ctx.canvas.orderedIds()
    const fire = Gradient.withSteps(this.#burnColors, 10, false)
    while (!algo.complete) algo.step()
    for (const id of order) {
      const a = ctx.anim(id)
      const final = a.homeFg ?? FALLBACK_FINAL
      ctx.setVisible(id, true)
      ctx.setAppearance(id, a.inputSym, this.#starting)
      ctx.newScene(id, 'burn')
      ctx.applyGradient(id, 'burn', BURN_ORDER, 4, fire.spectrum)
      ctx.newScene(id, `final_${id}`)
      const fg = Gradient.withSteps([fire.spectrum[fire.spectrum.length - 1] as Rgb, final], 8, false)
      for (const fc of fg.spectrum) ctx.addFrame(id, `final_${id}`, a.inputSym, 4, fc)
      ctx.addFrame(id, `final_${id}`, a.inputSym, 4, a.homeFg)
      ctx.registerEvent(id, 'scene_complete', 'burn', { type: 'scene', name: `final_${id}` })
      ctx.registerEvent(id, 'scene_complete', 'burn', { type: 'callback', id: 0 })
    }
    this.#linkOrder.push(...algo.charLinkOrder)
  }

  /** One tick; null when the ignition front and all burners finished. */
  nextFrame(): FrameCell[] | null {
    const ctx = this.#ctx
    if (this.#linkOrder.length > 0 || !ctx.activeEmpty) {
      const n = ctx.rng.randint(2, 4)
      for (let i = 0; i < n; i += 1) {
        if (this.#linkOrder.length === 0) break
        const id = this.#linkOrder.shift() as number
        if (ctx.anim(id).inputSym !== ' ') {
          ctx.activateScene(id, 'burn')
          ctx.activeInclude(id)
        }
      }
      ctx.update(this)
      return ctx.frameCells()
    }
    return null
  }
}
