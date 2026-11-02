import { describe, expect, it } from 'vitest'
import { Canvas } from '../src/ttfx/grid.ts'
import type { GridCell } from '../src/ttfx/grid.ts'
import { ParticlePool } from '../src/ttfx/particles.ts'
import { Rng } from '../src/ttfx/rng.ts'
import { EngineCtx, MotionPath } from '../src/ttfx/scene.ts'
import { PrimsSimple, SpanningTree } from '../src/ttfx/spanning.ts'

const cell = (sym: string): GridCell => ({ sym, fg: [20, 40, 60], bg: null })
const box: GridCell[][] = [[cell('A'), cell('B')], [cell('C'), cell('D')]]

function context(lines: GridCell[][] = box, seed = 1): EngineCtx {
  return new EngineCtx(new Canvas(lines.length, Math.max(...lines.map(line => line.length)), lines), new Rng(seed))
}

describe('ttfx spanning trees and particle pools', () => {
  it('links characters idempotently and filters null, occupied, and out-of-text neighbors', () => {
    const ctx = context([[cell(' '), cell(' ')], [cell('A'), cell(' ')]])
    const first = ctx.canvas.charByCoord(1, 1)
    expect(first).not.toBeNull()
    const id = first as number
    const nearby = SpanningTree.neighbors(ctx, id, false, false)
    expect(nearby.length).toBeGreaterThan(0)
    expect(SpanningTree.neighbors(ctx, id, false, true)).toEqual([])
    const east = ctx.anim(id).east
    expect(east).not.toBeNull()
    SpanningTree.linkCharacters(ctx, id, east as number)
    SpanningTree.linkCharacters(ctx, id, east as number)
    ctx.anim(east as number).links = [2, 3]
    SpanningTree.linkCharacters(ctx, id, east as number)
    expect(ctx.anim(id).links).toEqual([east])
    expect(ctx.anim(east as number).links).toEqual([id, 2, 3])
    expect(SpanningTree.neighbors(ctx, id, true, false)).not.toContain(east)
  })

  it('expands Prim order until all connected characters are linked', () => {
    const ctx = context()
    const tree = new PrimsSimple(ctx, 0, true)
    expect(tree.complete).toBe(false)
    for (let i = 0; i < 100 && !tree.complete; i += 1) tree.step()
    expect(tree.complete).toBe(true)
    expect(tree.charLinkOrder).toHaveLength(4)
    expect(new Set(tree.charLinkOrder).size).toBe(4)
    expect(new PrimsSimple(ctx, null, false).charLinkOrder).toHaveLength(1)
    const disconnected = context([[cell('A'), cell(' ')]])
    const single = new PrimsSimple(disconnected, 0, true)
    single.step()
    single.step()
    expect(single.complete).toBe(true)
  })

  it('preallocates, acquires, resets, exhausts, and reclaims pool members', () => {
    const ctx = context([[cell('A')]])
    expect(() => new ParticlePool([], null)).toThrow()
    expect(() => { new ParticlePool(['.'], 1).preallocate(ctx, 2) }).toThrow()
    new ParticlePool(['x'], null).preallocate(ctx, 0)
    const pool = new ParticlePool(['.', '*'], 2, [4, 5])
    pool.preallocate(ctx, 2)
    const id = pool.acquire(ctx)
    expect(id).not.toBeNull()
    expect(ctx.anim(id as number).curCol).toBe(4)
    expect(ctx.anim(id as number).curRow).toBe(5)
    ParticlePool.resetParticle(ctx, id as number, false, false, false)
    ctx.anim(id as number).activePath = 'p'
    ctx.anim(id as number).active = 's'
    ctx.anim(id as number).paths.set('p', new MotionPath('p', 1, null, 0, false))
    ctx.activeInclude(id as number)
    expect(pool.acquire(ctx)).not.toBeNull()
    const remaining = pool.acquire(ctx)
    expect(remaining).toBeNull()
    pool.reclaim(ctx, id as number, true, true)
    expect(ctx.anim(id as number).visible).toBe(false)
    expect(ctx.anim(id as number).activePath).toBeNull()
    expect(ctx.anim(id as number).active).toBeNull()
    expect(ctx.active).not.toContain(id)
    pool.reclaim(ctx, id as number, false, false)
    expect(pool.acquire(ctx)).toBe(id)
  })
})
