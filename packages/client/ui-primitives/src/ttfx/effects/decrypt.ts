/**
 * Decrypt effect, ported from the ttfx Ruby port (`ttfx/effects/decrypt.rb`).
 * Two phases: typing (block chars resolving to one cipher symbol) then
 * decrypting (fast cipher frames, slow settle frames, then white → home
 * color discovered frames). The home color is the sampled image color.
 * @module ui-primitives/ttfx/effects/decrypt
 */

import type { EngineCtx, FrameCell } from '../scene.ts'
import { Gradient, fromHex } from '../color.ts'
import type { Rgb } from '../color.ts'
import type { TtfxEffect } from '../effects.ts'

/** Block glyphs cycled by the typing phase. */
const BLOCKS = ['▉', '▓', '▒', '░']
/** Default cipher greens. */
const DEFAULT_CIPHER: readonly string[] = ['008000', '00cb00', '00ff00']
/** Fallback home color when a cell sampled no foreground. */
const FALLBACK_FINAL: Rgb = [255, 255, 255]

/** Decrypt reveal: movie-style cipher scramble resolving into the mark. */
export class DecryptEffect implements TtfxEffect {
  readonly #ctx: EngineCtx
  readonly #typingSpeed: number
  readonly #fastFrames: number
  readonly #cipherColors: Rgb[]
  #phase: 'typing' | 'decrypting' = 'typing'
  readonly #typingPending: number[] = []
  readonly #decryptingPending: number[] = []
  readonly #symbols: string[] = []

  /** @param ctx - engine context. @param opts - `typing_speed`, `ciphertext_colors`, `fast_frames`. */
  constructor(ctx: EngineCtx, opts: Record<string, unknown>) {
    this.#ctx = ctx
    this.#typingSpeed = (opts.typing_speed as number | undefined) ?? 2
    this.#fastFrames = (opts.fast_frames as number | undefined) ?? 30
    const cipherHex = (opts.ciphertext_colors as readonly string[] | undefined) ?? DEFAULT_CIPHER
    this.#cipherColors = cipherHex.map(h => fromHex(h) ?? FALLBACK_FINAL)
  }

  #makeSymbols(): void {
    for (let n = 33; n < 127; n += 1) this.#symbols.push(String.fromCodePoint(n))
    for (let n = 9608; n < 9632; n += 1) this.#symbols.push(String.fromCodePoint(n))
    for (let n = 9472; n < 9599; n += 1) this.#symbols.push(String.fromCodePoint(n))
    for (let n = 174; n < 452; n += 1) this.#symbols.push(String.fromCodePoint(n))
  }

  #chooseCipher(): Rgb {
    return this.#ctx.rng.choice(this.#cipherColors)
  }

  #chooseSymbol(): string {
    return this.#ctx.rng.choice(this.#symbols)
  }

  /** Build typing + decrypting scenes over the ordered characters. */
  build(): void {
    this.#makeSymbols()
    const ctx = this.#ctx
    const order = ctx.canvas.orderedIds()
    // Typing scenes.
    for (const id of order) {
      ctx.newScene(id, 'typing')
      for (const b of BLOCKS) ctx.addFrame(id, 'typing', b, 2, this.#chooseCipher())
      ctx.addFrame(id, 'typing', this.#chooseSymbol(), 1, this.#chooseCipher())
      this.#typingPending.push(id)
    }
    // Decrypting scenes.
    const white: Rgb = [255, 255, 255]
    for (const id of order) {
      const a = ctx.anim(id)
      ctx.newScene(id, 'fast_decrypt')
      const color = this.#chooseCipher()
      for (let i = 0; i < this.#fastFrames; i += 1) {
        ctx.addFrame(id, 'fast_decrypt', this.#chooseSymbol(), 2, color)
      }
      ctx.newScene(id, 'slow_decrypt')
      const count = ctx.rng.randint(1, 15)
      for (let i = 0; i < count; i += 1) {
        const sym = this.#chooseSymbol()
        let dur: number
        if (ctx.rng.randint(0, 100) <= 30) dur = ctx.rng.randrange(35, 60)
        else dur = ctx.rng.randrange(3, 6)
        ctx.addFrame(id, 'slow_decrypt', sym, dur, color)
      }
      ctx.newScene(id, 'discovered')
      const disc = Gradient.withSteps([white, a.homeFg ?? white], 10, false)
      ctx.applyGradient(id, 'discovered', [a.inputSym], 5, disc.spectrum)
      ctx.addFrame(id, 'discovered', a.inputSym, 2, a.homeFg)
      ctx.registerEvent(id, 'scene_complete', 'fast_decrypt', { type: 'scene', name: 'slow_decrypt' })
      ctx.registerEvent(id, 'scene_complete', 'slow_decrypt', { type: 'scene', name: 'discovered' })
      ctx.activateScene(id, 'fast_decrypt')
      this.#decryptingPending.push(id)
    }
  }

  /** One tick; null when the animation completed. */
  nextFrame(): FrameCell[] | null {
    const ctx = this.#ctx
    if (this.#phase === 'typing') {
      if (this.#typingPending.length > 0 || !ctx.activeEmpty) {
        if (this.#typingPending.length > 0 && ctx.rng.randint(0, 100) <= 75) {
          let k = 0
          while (k < this.#typingSpeed) {
            if (this.#typingPending.length === 0) break
            const id = this.#typingPending.shift() as number
            ctx.setVisible(id, true)
            ctx.activateScene(id, 'typing')
            ctx.activeInclude(id)
            k += 1
          }
        }
        ctx.update()
        return ctx.frameCells()
      }
      ctx.activeClear()
      for (const id of this.#decryptingPending) {
        ctx.activeInclude(id)
        ctx.activateScene(id, 'fast_decrypt')
      }
      this.#phase = 'decrypting'
    }
    if (!ctx.activeEmpty) {
      ctx.update()
      return ctx.frameCells()
    }
    return null
  }
}
