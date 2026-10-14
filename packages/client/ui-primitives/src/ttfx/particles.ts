/**
 * Particle pool, ported from the ttfx Ruby port (`ttfx/particles.rb`).
 * Preallocated arena characters recycled as particles; the available queue
 * pops from the back and reclaim is idempotent.
 * @module ui-primitives/ttfx/particles
 */

import type { EngineCtx } from './scene.ts'

/**
 * Arena-character pool for transient particles (burn smoke, and similar).
 */
export class ParticlePool {
  readonly #symbols: readonly string[]
  readonly #maxSize: number | null
  readonly #col: number
  readonly #row: number
  readonly #available: number[] = []
  /** All pooled arena ids (preallocation order). */
  readonly particles: number[] = []

  /**
   * @param symbols - particle symbols (≥ 1; choices are made at preallocate).
   * @param maxSize - pool cap, or null for unbounded.
   * @param coord - spawn coordinate `[col, row]` (default `[0, 0]`).
   */
  constructor(symbols: readonly string[], maxSize: number | null, coord?: readonly [number, number]) {
    if (symbols.length === 0) throw new Error('ParticlePool requires at least one symbol.')
    this.#symbols = symbols
    this.#maxSize = maxSize
    this.#col = coord === undefined ? 0 : coord[0]
    this.#row = coord === undefined ? 0 : coord[1]
  }

  /**
   * Preallocate pool characters (one random symbol each).
   * @param ctx - engine context.
   * @param count - characters to create (≤ maxSize when capped).
   */
  preallocate(ctx: EngineCtx, count: number): void {
    if (this.#maxSize !== null && this.#maxSize < count) {
      throw new Error('max_size must be greater than or equal to initial_count.')
    }
    for (let i = 0; i < count; i += 1) {
      const sym = ctx.rng.choice(this.#symbols)
      const id = ctx.addCharacter(sym, this.#col, this.#row)
      this.particles.push(id)
      this.#available.push(id)
    }
  }

  /** Reset a particle to pool defaults. */
  static resetParticle(ctx: EngineCtx, id: number, clearPaths: boolean, deactivatePath: boolean, deactivateScene: boolean): void {
    const a = ctx.anim(id)
    if (deactivatePath) a.activePath = null
    if (deactivateScene) a.active = null
    if (clearPaths) a.paths.clear()
  }

  /**
   * Pop an available particle (reset to defaults).
   * @returns the arena id, or null when the pool is exhausted.
   */
  acquire(ctx: EngineCtx): number | null {
    if (this.#available.length === 0) return null
    const id = this.#available.pop() as number
    ParticlePool.resetParticle(ctx, id, true, true, true)
    return id
  }

  /**
   * Return a particle to the pool.
   * @param hide - make the character invisible.
   * @param deactivate - clear its active scene and path.
   */
  reclaim(ctx: EngineCtx, id: number, hide: boolean, deactivate: boolean): void {
    if (hide) ctx.setVisible(id, false)
    if (deactivate) {
      const a = ctx.anim(id)
      a.activePath = null
      a.active = null
    }
    const idx = ctx.active.indexOf(id)
    if (idx >= 0) ctx.active.splice(idx, 1)
    if (!this.#available.includes(id)) this.#available.push(id)
  }
}
