/**
 * Fireworks effect, ported from the ttfx Ruby port
 * (`ttfx/effects/fireworks.rb`). Shells launch from the bottom, arc to an
 * apex, explode outward along bezier bloom paths, then fall home while
 * cross-fading from the shell color into the home (image) color.
 * Fully deterministic (seeded RNG only).
 * @module ui-primitives/ttfx/effects/fireworks
 */

import type { EngineCtx, FrameCell } from '../scene.ts'
import { Geometry } from '../scene.ts'
import { Gradient, fromHex } from '../color.ts'
import type { Rgb } from '../color.ts'
import { roundHalfEven } from '../pycompat.ts'
import type { TtfxEffect } from '../effects.ts'

/** Default firework palette. */
const DEFAULT_COLORS: readonly string[] = ['88F7E2', '44D492', 'F5EB67', 'FFA15C', 'FA233E']
/** Fallback home color when a cell sampled no foreground. */
const FALLBACK_FINAL: Rgb = [255, 255, 255]
const WHITE: Rgb = [255, 255, 255]

/** Fireworks reveal: shells launch, bloom, and rain into the mark. */
export class FireworksEffect implements TtfxEffect {
  readonly #ctx: EngineCtx
  readonly #explodeAnywhere: boolean
  readonly #colors: Rgb[]
  readonly #symbol: string
  readonly #volumeRatio: number
  readonly #launchDelayDefault: number
  readonly #explodeRatio: number
  readonly #shells: number[][] = []
  #volume = 0
  #explodeDistance = 0
  #launchDelay = 0

  /**
   * @param ctx - engine context.
   * @param opts - `explode_anywhere`, `firework_colors`, `firework_symbol`,
   *   `firework_volume`, `launch_delay`, and `explode_distance`.
   */
  constructor(ctx: EngineCtx, opts: Record<string, unknown>) {
    this.#ctx = ctx
    this.#explodeAnywhere = (opts.explode_anywhere as boolean | undefined) ?? false
    const colorHex = (opts.firework_colors as readonly string[] | undefined) ?? DEFAULT_COLORS
    this.#colors = colorHex.map(h => fromHex(h) ?? FALLBACK_FINAL)
    this.#symbol = (opts.firework_symbol as string | undefined) ?? 'o'
    this.#volumeRatio = (opts.firework_volume as number | undefined) ?? 0.05
    this.#launchDelayDefault = (opts.launch_delay as number | undefined) ?? 45
    this.#explodeRatio = (opts.explode_distance as number | undefined) ?? 0.2
  }

  /** Build launch/explode/fall paths and per-shell scenes. */
  build(): void {
    const ctx = this.#ctx
    const cv = ctx.canvas
    this.#volume = Math.max(1, roundHalfEven(this.#volumeRatio * cv.charCount))
    this.#explodeDistance = Math.min(15, Math.max(1, roundHalfEven(cv.right * this.#explodeRatio)))
    this.#launchDelay = 0
    this.#prepareWaypoints()
    this.#prepareScenes()
  }

  /** Assign shells of characters, launch origins, and bloom paths. */
  #prepareWaypoints(): void {
    const ctx = this.#ctx
    const cv = ctx.canvas
    const order = cv.orderedIds()
    let shell: number[] = []
    let originX = 0
    let origin: [number, number] = [0, 0]
    let circle: [number, number][] = []
    for (const id of order) {
      if (shell.length === this.#volume || shell.length === 0) {
        originX = ctx.rng.randrange(0, cv.right)
        this.#shells.push(shell)
        shell = []
        const a = ctx.anim(id)
        const minRow = this.#explodeAnywhere ? cv.bottom : a.inputRow
        origin = [originX, ctx.rng.randrange(minRow, cv.top + 1)]
        circle = Geometry.coordsInCircle(origin[0], origin[1], this.#explodeDistance)
      }
      const a = ctx.anim(id)
      ctx.motionSetCoordinate(id, originX, cv.bottom)
      ctx.motionNewPath(id, 'apex_pth', 0.35, 'out_expo', 0, false, 2)
      ctx.motionAddWaypoint(id, 'apex_pth', origin[0], origin[1])
      const speed = ctx.rng.uniform(0.2, 0.4)
      ctx.motionNewPath(id, 'explode_pth', speed, 'out_circ', 0, false, 2)
      const ex = ctx.rng.choice(circle)
      ctx.motionAddWaypoint(id, 'explode_pth', ex[0], ex[1])
      const [bx, by] = Geometry.extrapolateRay(origin[0], origin[1], ex[0], ex[1], this.#explodeDistance / 2)
      const wy = Math.max(1, by - 7)
      ctx.motionAddWaypoint(id, 'explode_pth', bx, wy, [[bx, by]])
      ctx.motionNewPath(id, 'input_pth', 0.6, 'in_out_quart', 0, false, 2)
      ctx.motionAddWaypoint(id, 'input_pth', a.inputCol, a.inputRow, [[bx, 1]])
      ctx.registerEvent(id, 'path_complete', 'apex_pth', { type: 'path', name: 'explode_pth' })
      ctx.registerEvent(id, 'path_complete', 'explode_pth', { type: 'path', name: 'input_pth' })
      ctx.registerEvent(id, 'path_complete', 'input_pth', { type: 'layer', layer: 0 })
      ctx.motionActivatePath(id, 'apex_pth')
      shell.push(id)
    }
    /* v8 ignore next -- a non-empty ordered canvas always adds its last character to a shell. */
    if (shell.length > 0) this.#shells.push(shell)
  }

  /** Launch loop scenes, step-synced bloom scenes, and fall gradients. */
  #prepareScenes(): void {
    const ctx = this.#ctx
    const white = WHITE
    for (const shell of this.#shells) {
      const shellColor = ctx.rng.choice(this.#colors)
      const sg = Gradient.withSteps([shellColor, white, shellColor], 5, false)
      for (const id of shell) {
        const a = ctx.anim(id)
        const final = a.homeFg ?? FALLBACK_FINAL
        ctx.newSceneLoop(id, 'launch')
        ctx.addFrame(id, 'launch', this.#symbol, 2, shellColor)
        ctx.addFrame(id, 'launch', this.#symbol, 1, white)
        ctx.newSceneSynced(id, 'bloom', 'step')
        for (const c of sg.spectrum) ctx.addFrame(id, 'bloom', a.inputSym, 2, c)
        ctx.newScene(id, 'fall_scn')
        const fg = Gradient.withSteps([shellColor, final], 15, false)
        ctx.applyGradient(id, 'fall_scn', [a.inputSym], 10, fg.spectrum)
        ctx.addFrame(id, 'fall_scn', a.inputSym, 10, a.homeFg)
        ctx.activateScene(id, 'launch')
        ctx.registerEvent(id, 'path_complete', 'apex_pth', { type: 'scene', name: 'bloom' })
        ctx.registerEvent(id, 'path_activated', 'input_pth', { type: 'scene', name: 'fall_scn' })
      }
    }
  }

  /** One tick; null when every shell exploded and fell home. */
  nextFrame(): FrameCell[] | null {
    const ctx = this.#ctx
    if (this.#shells.length > 0 || !ctx.activeEmpty) {
      if (this.#shells.length > 0 && this.#launchDelay <= 0) {
        const group = this.#shells.pop() as number[]
        for (const id of group) {
          ctx.setVisible(id, true)
          ctx.activeInclude(id)
        }
        this.#launchDelay = Math.trunc(this.#launchDelayDefault * ctx.rng.uniform(0.5, 1.5))
      }
      this.#launchDelay -= 1
      ctx.update()
      return ctx.frameCells()
    }
    return null
  }
}
