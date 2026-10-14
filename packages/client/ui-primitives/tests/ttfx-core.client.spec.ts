import { describe, expect, it } from 'vitest'
import { adjustBrightness, fromHex, Gradient } from '../src/ttfx/color.ts'
import { ease } from '../src/ttfx/easing.ts'
import { Canvas, coordKey } from '../src/ttfx/grid.ts'
import type { GridCell } from '../src/ttfx/grid.ts'
import { Rng } from '../src/ttfx/rng.ts'
import { EngineCtx, Geometry } from '../src/ttfx/scene.ts'
import { sampleImageGrid } from '../src/ttfx/image-grid.ts'
import type { PixelSource } from '../src/ttfx/image-grid.ts'
import { RevealRunner } from '../src/ttfx/run.ts'
import { EFFECT_IDS } from '../src/ttfx/effects.ts'

const grid: GridCell[][] = [
  [{ sym: 'A', fg: [20, 40, 60], bg: [70, 80, 90] }, { sym: 'B', fg: [30, 50, 70], bg: null }],
  [{ sym: 'C', fg: [40, 60, 80], bg: [90, 100, 110] }, { sym: ' ', fg: null, bg: null }],
]

describe('ttfx core', () => {
  it('parses RGB hex colors, preserving malformed and short rejection', () => {
    expect(fromHex('#ff0099')).toEqual([255, 0, 153])
    expect(fromHex('aBcDeF')).toEqual([171, 205, 239])
    expect(fromHex('fff')).toBeNull()
    expect(fromHex('zzzzzz')).toBeNull()
    expect(fromHex('1234567')).toEqual([18, 52, 86])
  })

  it('adjusts HSL lightness and handles gray', () => {
    expect(adjustBrightness([100, 50, 20], 0.5)).toEqual([50, 25, 10])
    expect(adjustBrightness([120, 120, 120], 1.5)).toEqual([180, 180, 180])
    expect(adjustBrightness([255, 0, 0], 0)).toEqual([0, 0, 0])
  })

  it('builds floor-stepped gradients and maps every direction', () => {
    expect(Gradient.withSteps([[0, 0, 0], [255, 127, 1]], 3, false).spectrum).toEqual([
      [0, 0, 0], [85, 42, 0], [170, 84, 0], [255, 127, 1],
    ])
    expect(Gradient.withSteps([[1, 2, 3]], 2, true).spectrum).toEqual([[1, 2, 3], [1, 2, 3]])
    expect(() => Gradient.build([], [1], true, false)).toThrow()
    expect(() => Gradient.build([[0, 0, 0]], [], true, false)).toThrow()
    expect(() => Gradient.withSteps([[0, 0, 0]], 0, false)).toThrow()
    const grad = Gradient.withSteps([[0, 0, 0], [255, 255, 255]], 4, false)
    expect(grad.colorAtFraction(0)).toEqual([0, 0, 0])
    expect(grad.colorAtFraction(1)).toEqual([255, 255, 255])
    expect(() => grad.colorAtFraction(-1)).toThrow(RangeError)
    expect(grad.coordMap(1, 2, 1, 3, 'vertical').get(2, 1)).toEqual([126, 126, 126])
    expect(grad.coordMap(1, 2, 1, 3, 'horizontal').get(3, 1)).toEqual([255, 255, 255])
    expect(grad.coordMap(1, 2, 1, 3, 'diagonal').get(3, 2)).toEqual([255, 255, 255])
    expect(grad.coordMap(1, 2, 1, 3, 'radial').get(2, 1)).not.toBeNull()
    expect(grad.coordMap(1, 2, 1, 3, 'vertical').get(0, 0)).toBeNull()
    expect(() => grad.coordMap(2, 1, 1, 3, 'vertical')).toThrow()
  })

  it('runs easing and deterministic random operations', () => {
    expect(ease('in_quad', 0.5)).toBe(0.25)
    expect(ease('out_quad', 0.5)).toBe(0.75)
    expect(ease('in_out_sine', 0)).toBeCloseTo(0)
    expect(ease('in_out_sine', 1)).toBe(1)
    const a = new Rng(42)
    const b = new Rng(42)
    expect(Array.from({ length: 6 }, () => a.randint(0, 100))).toEqual(Array.from({ length: 6 }, () => b.randint(0, 100)))
    const rng = new Rng(1)
    expect(rng.randrange(2, 3)).toBe(2)
    expect(rng.choice(['x'])).toBe('x')
    const values = [1, 2, 3, 4]
    rng.shuffle(values)
    expect([...values].sort()).toEqual([1, 2, 3, 4])
    expect(rng.uniform(2, 2)).toBe(2)
  })

  it('builds the canvas arena, fills holes, groups ids and picks coordinates', () => {
    const canvas = new Canvas(2, 2, grid)
    expect(canvas.charCount).toBe(3)
    expect(canvas.right).toBe(2)
    expect(canvas.top).toBe(2)
    expect(canvas.textWidth).toBe(2)
    expect(canvas.charByCoord(2, 1)).not.toBeNull()
    expect(canvas.charByCoord(2, 2)).not.toBeNull()
    expect(canvas.allIds()).toHaveLength(4)
    expect(canvas.orderedIds()).toHaveLength(3)
    expect(canvas.groupedIds('column_left_to_right')).toHaveLength(2)
    expect(canvas.groupedIds('row_top_to_bottom')).toHaveLength(2)
    expect(canvas.groupedIds('center_to_outside')).toHaveLength(3)
    expect(canvas.groupedIds('diagonal_bottom_left_to_top_right')).toHaveLength(3)
    expect(coordKey(2, 3)).toBe(2_000_003)
    const rng = new Rng(2)
    expect(canvas.randomColumn(rng, true)).toBeGreaterThanOrEqual(canvas.textLeft)
    expect(canvas.randomRow(rng, false)).toBeGreaterThanOrEqual(1)
    expect(canvas.randomCoord(rng, true, false)).toHaveLength(2)
    expect(() => new Canvas(2, 2, [[{ sym: ' ', fg: null, bg: null }]])).toThrow()
  })

  it('moves characters, advances scenes and paths, fires events, and renders home colors', () => {
    const canvas = new Canvas(2, 2, grid)
    const ctx = new EngineCtx(canvas, new Rng(5))
    const id = canvas.orderedIds()[0]
    ctx.setVisible(id, true)
    ctx.newScene(id, 'a')
    ctx.addFrame(id, 'a', 'x', 1, [1, 2, 3])
    ctx.addFrame(id, 'a', 'y', 1, null)
    ctx.activateScene(id, 'a')
    ctx.activeInclude(id)
    ctx.update()
    expect(ctx.anim(id).curSym).toBe('x')
    ctx.motionNewPath(id, 'move', 1, 'linear', 0, false)
    ctx.motionAddWaypoint(id, 'move', 2, 2)
    ctx.registerEvent(id, 'path_complete', 'move', { type: 'layer', layer: 3 })
    ctx.motionActivatePath(id, 'move')
    ctx.activeInclude(id)
    ctx.update()
    ctx.update()
    expect(ctx.anim(id).layer).toBe(3)
    expect(ctx.anim(id).activePath).toBeNull()
    expect(ctx.frameCells().length).toBeGreaterThan(0)
    expect(ctx.lineLength(1, 1, 2, 2)).toBeCloseTo(Math.sqrt(5))
    expect(ctx.coordOnLine(1, 1, 3, 3, 0.5)).toEqual([2, 2])
    expect(Geometry.extrapolateRay(1, 1, 1, 1, 2)).toEqual([1, 1])
    expect(Geometry.coordsInCircle(1, 1, 0)).toEqual([])
    expect(Geometry.coordsInCircle(1, 1, 2).length).toBeGreaterThan(0)
    ctx.deactivateScene(id)
    ctx.resetScene(id, 'a')
    ctx.motionDeactivatePath(id, null)
    ctx.activeClear()
    expect(ctx.activeEmpty).toBe(true)
  })

  it('samples half-block cells with alpha and rounded-corner masks', () => {
    const source: PixelSource = {
      width: 4,
      height: 4,
      pixel: (x, y) => x === 0 || y === 0 ? [1, 2, 3, 0] : [x, y, 100, 255],
    }
    expect(sampleImageGrid(source, { cols: 2 }).length).toBe(1)
    const transparent: PixelSource = { width: 4, height: 4, pixel: () => [0, 0, 0, 0] }
    const rounded = sampleImageGrid(transparent, { cols: 2, cornerRadiusRatio: 0.5 })
    expect(rounded.flat().every(cell => cell.sym === ' ')).toBe(true)
    expect(() => sampleImageGrid(source, { cols: 0 })).toThrow(RangeError)
  })

  it('runs every curated effect to completion with the exact home frame', () => {
    const expected = grid.flatMap((line, index) => line.flatMap((cell, col) => cell.sym === ' '
      ? []
      : [{ row: grid.length - index, col: col + 1, sym: cell.sym, fg: cell.fg, bg: cell.bg }]))
    for (const effect of EFFECT_IDS) {
      const runner = new RevealRunner(grid, { effect, seed: 44 })
      const replay = new RevealRunner(grid, { effect, seed: 44 })
      let frame = runner.next()
      expect(frame, `${effect} deterministic first frame`).toEqual(replay.next())
      let ticks = 0
      let last = frame
      while (frame !== null && ticks < 4000) {
        last = frame
        frame = runner.next()
        expect(frame, `${effect} deterministic frame ${ticks + 1}`).toEqual(replay.next())
        ticks += 1
      }
      expect(frame, `${effect} completion`).toBeNull()
      expect(ticks, `${effect} tick count`).toBeGreaterThan(0)
      expect(last, `${effect} final frame`).toEqual(expected)
    }
  })
})
