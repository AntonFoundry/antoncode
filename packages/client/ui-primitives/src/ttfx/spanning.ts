/**
 * Prim's link-order generator, ported from the ttfx Ruby port
 * (`ttfx/spanning.rb`, `PrimsSimple`). Links stay id-sorted (canonical
 * order). Only the generators the curated effect set consumes are ported.
 * @module ui-primitives/ttfx/spanning
 */

import type { EngineCtx } from './scene.ts'

/** Neighbor-walk helpers shared by the generators. */
export const SpanningTree = {
  /**
   * Link two characters both ways (id-sorted, idempotent).
   * @param ctx - engine context.
   * @param a - first character id.
   * @param b - second character id.
   */
  linkCharacters(ctx: EngineCtx, a: number, b: number): void {
    const la = ctx.anim(a).links
    if (!la.includes(b)) ctx.anim(a).links = [...la, b].sort((x, y) => x - y)
    const lb = ctx.anim(b).links
    if (!lb.includes(a)) ctx.anim(b).links = [...lb, a].sort((x, y) => x - y)
  },

  /**
   * Neighbor ids of a character.
   * @param ctx - engine context.
   * @param id - character id.
   * @param unlinkedOnly - only neighbors with no links yet.
   * @param limitToText - only neighbors inside the text bounds.
   * @returns neighbor ids in N/E/S/W order.
   */
  neighbors(ctx: EngineCtx, id: number, unlinkedOnly: boolean, limitToText: boolean): number[] {
    const a = ctx.anim(id)
    const out: number[] = []
    for (const n of [a.north, a.east, a.south, a.west]) {
      if (n === null) continue
      if (limitToText) {
        const c = ctx.anim(n)
        const cv = ctx.canvas
        if (c.inputCol < cv.textLeft || c.inputCol > cv.textRight || c.inputRow < cv.textBottom || c.inputRow > cv.textTop) continue
      }
      if (unlinkedOnly && ctx.anim(n).links.length > 0) continue
      out.push(n)
    }
    return out
  },

  /**
   * Random starting character over the canvas (or text bounds).
   * @param ctx - engine context.
   * @param withinText - restrict the random pick to text bounds.
   * @returns arena id, or null when the pick landed on an empty cell.
   */
  defaultStartingChar(ctx: EngineCtx, withinText: boolean): number | null {
    const coord = ctx.canvas.randomCoord(ctx.rng, false, withinText)
    return ctx.canvas.charByCoord(coord[0], coord[1])
  },
}

/** Prim's link-order generator (random edge/neighbor picks). */
export class PrimsSimple {
  readonly #ctx: EngineCtx
  readonly #limit: boolean
  #current: number
  #edgeChars: number[]
  readonly #linkOrder: number[]
  #complete = false

  /** {@link charLinkOrder} completes before {@link complete} flips. */
  constructor(ctx: EngineCtx, starting: number | null, limitToText: boolean) {
    this.#ctx = ctx
    this.#limit = limitToText
    const start = starting ?? SpanningTree.defaultStartingChar(ctx, limitToText)
    /* v8 ignore next -- Canvas fills every in-bounds cell before this picker runs. */
    if (start === null) throw new Error('Unable to find a starting character.')
    this.#current = start
    this.#edgeChars = [start]
    this.#linkOrder = [start]
  }

  /** True once every character is linked. */
  get complete(): boolean {
    return this.#complete
  }

  /** Ids in the order Prim's linked them (ignition order for burn). */
  get charLinkOrder(): number[] {
    return this.#linkOrder
  }

  /** Expand one Prim's step. */
  step(): void {
    if (this.#edgeChars.length === 0) {
      this.#complete = true
      return
    }
    const idx = this.#ctx.rng.randrange(0, this.#edgeChars.length)
    this.#current = this.#edgeChars.splice(idx, 1)[0] as number
    const unlinked = SpanningTree.neighbors(this.#ctx, this.#current, true, this.#limit)
    if (unlinked.length > 0) {
      const nidx = this.#ctx.rng.randrange(0, unlinked.length)
      const nxt = unlinked.splice(nidx, 1)[0] as number
      SpanningTree.linkCharacters(this.#ctx, this.#current, nxt)
      this.#linkOrder.push(nxt)
      if (unlinked.length > 0) this.#edgeChars.push(this.#current)
      const nn = SpanningTree.neighbors(this.#ctx, nxt, true, this.#limit)
      if (nn.length > 0) this.#edgeChars.push(nxt)
    }
  }
}
