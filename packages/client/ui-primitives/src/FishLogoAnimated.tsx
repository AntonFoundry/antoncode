/**
 * Animated hero Anton mark: samples the source image to a half-block grid,
 * runs one ttfx effect per entrance/hover, draws the animation on a canvas,
 * and leaves the image visible under the overlay so failures degrade to the
 * static mark. Reduced-motion users get the static image only. The 24fps
 * driver caps work on the 4,319-cell hero grid.
 * @module ui-primitives/FishLogoAnimated
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { browserImageDom, loadPixelSource, sampleImageGrid } from './ttfx/image-grid.ts'
import type { ImageDomAdapter, PixelSource } from './ttfx/image-grid.ts'
import type { GridCell } from './ttfx/grid.ts'
import { RevealRunner } from './ttfx/run.ts'
import type { EffectId } from './ttfx/effects.ts'
import { EFFECT_IDS } from './ttfx/effects.ts'
import type { FrameCell } from './ttfx/scene.ts'
import type { Rgb } from './ttfx/color.ts'

const MARK_URL = '/anton-mark.png'
const GRID_COLS = 96
const CORNER_RATIO = 0.28
const FPS_INTERVAL = 1000 / 24
/**
 * Choose one opening effect from the curated roster.
 * @param random - source of a value in the interval [0, 1].
 * @returns selected effect.
 */
export function chooseRandomEffect(random: () => number): EffectId {
  const index = Math.min(EFFECT_IDS.length - 1, Math.floor(random() * EFFECT_IDS.length))
  return EFFECT_IDS[index] as EffectId
}

/** True when the browser explicitly requests reduced motion. */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Injectable RAF/clock surface for deterministic component tests. */
export interface AnimationClock {
  /** Request one animation frame. */
  request(callback: FrameRequestCallback): number
  /** Cancel a requested animation frame. */
  cancel(id: number): void
  /** Current high-resolution timestamp. */
  now(): number
}

/** Injectable rendering surface for deterministic component tests. */
export interface FishLogoAnimatedAdapters {
  /** Image decoding + pixel access adapter. */
  imageDom: ImageDomAdapter
  /** RAF/clock adapter (defaults to the browser APIs). */
  clock?: AnimationClock
  /** Optional sampler override for deterministic tests. */
  sampleGrid?: (source: PixelSource, cols: number, cornerRadiusRatio: number) => GridCell[][]
  /** Optional RNG override for deterministic tests. */
  random?: () => number
}

/** Animated fish logo props. */
export interface FishLogoAnimatedProps {
  /** Edge length in CSS pixels (default 288). */
  size?: number
  /** Extra class for layout placement. */
  className?: string
  /** Auto-run a randomly selected effect on mount (default true). */
  entrance?: boolean
  /** Disable pointer-enter effect cycle (default false). */
  disableHover?: boolean
  /** Test-only adapter override. */
  adapters?: FishLogoAnimatedAdapters
}

/** Browser RAF adapter. */
const browserClock: AnimationClock = {
  request: callback => requestAnimationFrame(callback),
  cancel: (id) => { cancelAnimationFrame(id) },
  now: () => performance.now(),
}

/** Default browser adapters (resolved at component render in browser only). */
const defaultSampler = (source: PixelSource, cols: number, cornerRadiusRatio: number): GridCell[][] =>
  sampleImageGrid(source, { cols, cornerRadiusRatio })

const DEFAULT_ADAPTERS: FishLogoAnimatedAdapters = {
  imageDom: browserImageDom(),
  clock: browserClock,
}

/**
 * Paint one rendered frame onto the 2D canvas, with character cells using
 * terminal 1:2 geometry (each `▀` cell occupies 1×2 virtual pixels).
 * @param canvas - drawing canvas.
 * @param cells - runner frame cells.
 * @param cols - sampled grid width.
 * @param rows - sampled grid height.
 */
export function drawFrame(canvas: HTMLCanvasElement, cells: readonly FrameCell[], cols: number, rows: number): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const cellW = canvas.width / cols
  const cellH = canvas.height / rows
  for (const cell of cells) {
    const x = (cell.col - 1) * cellW
    const y = (rows - cell.row) * cellH
    if (cell.sym === '▀') {
      fillHalf(ctx, x, y, cellW, cellH / 2, cell.fg)
      fillHalf(ctx, x, y + cellH / 2, cellW, cellH / 2, cell.bg)
    } else if (cell.sym === '▄') {
      fillHalf(ctx, x, y, cellW, cellH / 2, cell.bg)
      fillHalf(ctx, x, y + cellH / 2, cellW, cellH / 2, cell.fg)
    } else if (cell.sym === '█') {
      fillHalf(ctx, x, y, cellW, cellH, cell.fg)
    } else if (cell.sym !== ' ') {
      fillHalf(ctx, x, y, cellW, cellH, cell.fg)
    }
  }
}

/** Fill one colored rectangle; null leaves it transparent. */
function fillHalf(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: Rgb | null): void {
  if (color === null) return
  ctx.fillStyle = `rgb(${color[0]} ${color[1]} ${color[2]})`
  ctx.fillRect(x, y, w, h)
}

/** Render an animated mark; designed for the hero, not the sidebar. */
export function FishLogoAnimated({
  size = 288,
  className,
  entrance = true,
  disableHover = false,
  adapters,
}: FishLogoAnimatedProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sourceRef = useRef<PixelSource | null>(null)
  const nextEffectRef = useRef(0)
  const activeRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef(0)
  const resolvedAdapters = adapters ?? DEFAULT_ADAPTERS
  const clock = resolvedAdapters.clock ?? browserClock
  const dom = resolvedAdapters.imageDom
  const sampler = resolvedAdapters.sampleGrid ?? defaultSampler
  const random = resolvedAdapters.random ?? Math.random
  const openingEffectRef = useRef<EffectId | null>(null)
  if (openingEffectRef.current === null) openingEffectRef.current = chooseRandomEffect(random)
  const openingEffect = openingEffectRef.current
  const hoverCycle = useMemo(() => EFFECT_IDS.filter(effect => effect !== openingEffect), [openingEffect])

  const play = useCallback((effect: EffectId) => {
    const source = sourceRef.current
    const canvas = canvasRef.current
    if (prefersReducedMotion()) return
    if (source === null) return
    /* v8 ignore next -- React attaches this ref in the commit before its event handlers run. */
    if (canvas === null) return
    activeRef.current = true
    const grid = sampler(source, GRID_COLS, CORNER_RATIO)
    const rows = grid.length
    canvas.width = GRID_COLS
    canvas.height = rows * 2
    const runner = new RevealRunner(grid, { effect, seed: Math.floor(clock.now()) })
    lastTickRef.current = 0
    const tick = (timestamp: number): void => {
      if (!activeRef.current) return
      if (timestamp - lastTickRef.current >= FPS_INTERVAL) {
        const cells = runner.next()
        if (cells === null) {
          activeRef.current = false
          canvas.style.opacity = '0'
          return
        }
        drawFrame(canvas, cells, GRID_COLS, rows)
        canvas.style.opacity = '1'
        lastTickRef.current = timestamp
      }
      rafRef.current = clock.request(tick)
    }
    rafRef.current = clock.request(tick)
  }, [clock, sampler])

  useEffect(() => {
    let disposed = false
    if (prefersReducedMotion()) return () => { disposed = true }
    void loadPixelSource(MARK_URL, dom).then((source) => {
      if (disposed) return
      sourceRef.current = source
      if (entrance) play(openingEffect)
    }).catch(() => {
      // Image decoding can fail when the static asset is unavailable; the img remains visible.
    })
    return () => {
      disposed = true
      activeRef.current = false
      if (rafRef.current !== null) clock.cancel(rafRef.current)
    }
  }, [clock, dom, entrance, openingEffect, play])

  const onPointerEnter = useCallback((_event: PointerEvent<HTMLSpanElement>) => {
    if (disableHover || prefersReducedMotion()) return
    if (activeRef.current) return
    const effect = hoverCycle[nextEffectRef.current % hoverCycle.length] as EffectId
    nextEffectRef.current += 1
    play(effect)
  }, [disableHover, hoverCycle, play])

  const style: CSSProperties = { width: size, height: size, display: 'block', borderRadius: size * 0.28 }
  const overlayStyle: CSSProperties = {
    position: 'absolute', inset: 0, width: size, height: size,
    borderRadius: size * 0.28, opacity: 0, pointerEvents: 'none', transition: 'opacity 180ms ease-out',
  }

  return (
    <span
      onPointerEnter={onPointerEnter}
      className={className}
      style={{ position: 'relative', display: 'inline-block', width: size, height: size }}
    >
      <img src={MARK_URL} width={size} height={size} alt="" aria-hidden="true" style={style} />
      <canvas ref={canvasRef} aria-hidden="true" style={overlayStyle} />
    </span>
  )
}
