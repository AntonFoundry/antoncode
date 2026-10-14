/**
 * Image → half-block character grid sampler. Samples a pixel source into a
 * `▀`-cell grid (fg = upper-half pixel, bg = lower-half pixel) sized to a
 * terminal cell aspect of 1:2, with an optional rounded-corner mask matching
 * the mark's CSS `border-radius` and an injectable DOM adapter so jsdom
 * tests cover the browser loader without real decoding.
 * @module ui-primitives/ttfx/image-grid
 */

import type { GridCell } from './grid.ts'

/** RGBA quadruple, channels 0..255. */
export type Rgba = readonly [number, number, number, number]

/** Decoded pixel accessor, top-left origin. */
export interface PixelSource {
  /** Source width in pixels. */
  readonly width: number
  /** Source height in pixels. */
  readonly height: number
  /**
   * Pixel at (x, y).
   * @param x - column, 0-based.
   * @param y - row, 0-based from the top.
   * @returns the RGBA pixel.
   */
  pixel(x: number, y: number): Rgba
}

/** Grid sampling options. */
export interface GridSampleOptions {
  /** Terminal columns of the sampled grid. */
  cols: number
  /** Alpha strictly below this counts as transparent (default 8). */
  alphaThreshold?: number
  /** Rounded-corner radius as a fraction of the source width (default 0). */
  cornerRadiusRatio?: number
}

/**
 * Sample the source into half-block cells, top line first. A cell's upper
 * half carries the fg color, its lower half the bg color; halves outside
 * the rounded-corner mask or below the alpha threshold are null, and a
 * cell with no visible half samples as a skipped space cell.
 * @param src - decoded pixel source.
 * @param options - see {@link GridSampleOptions}.
 * @returns laid-out grid lines (top first), one {@link GridCell} per column.
 */
export function sampleImageGrid(src: PixelSource, options: GridSampleOptions): GridCell[][] {
  const cols = options.cols
  if (cols < 1) throw new RangeError(`cols must be at least 1. Received: ${cols}`)
  const alphaThreshold = options.alphaThreshold ?? 8
  const radius = (options.cornerRadiusRatio ?? 0) * src.width
  const cellW = src.width / cols
  const cellH = cellW * 2
  const rows = Math.max(1, Math.round(src.height / cellH))
  const lines: GridCell[][] = []
  for (let r = 0; r < rows; r += 1) {
    const line: GridCell[] = []
    for (let c = 0; c < cols; c += 1) {
      const x = Math.floor((c + 0.5) * cellW)
      const topY = Math.floor((r + 0.25) * cellH)
      const botY = Math.floor((r + 0.75) * cellH)
      line.push({
        sym: '▀',
        fg: sampleHalf(src, x, topY, alphaThreshold, radius),
        bg: sampleHalf(src, x, botY, alphaThreshold, radius),
      })
    }
    lines.push(line)
  }
  for (const line of lines) {
    for (const cell of line) {
      if (cell.fg === null && cell.bg === null) cell.sym = ' '
    }
  }
  return lines
}

/** Sample one half-cell: null when masked out or transparent. */
function sampleHalf(src: PixelSource, x: number, y: number, alphaThreshold: number, radius: number): [number, number, number] | null {
  if (x < 0 || y < 0 || x >= src.width || y >= src.height) return null
  if (!insideRoundedRect(src.width, src.height, radius, x, y)) return null
  const [r, g, b, a] = src.pixel(x, y)
  if (a < alphaThreshold) return null
  return [r, g, b]
}

/** Rounded-rect containment test (mask matches the CSS border-radius clip). */
function insideRoundedRect(width: number, height: number, radius: number, x: number, y: number): boolean {
  if (radius <= 0) return true
  const cx = x < radius ? radius : x > width - radius ? width - radius : x
  const cy = y < radius ? radius : y > height - radius ? height - radius : y
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

/** Minimal 2D draw surface the loader reads pixels through. */
export interface DrawSurface {
  /** Blit a decoded image at (dx, dy). */
  drawImage(source: unknown, dx: number, dy: number): void
  /** Read raw RGBA data for a rectangle. */
  getImageData(sx: number, sy: number, sw: number, sh: number): { readonly data: ArrayLike<number> }
}

/** Decoding DOM adapter; injectable so tests stub the browser APIs. */
export interface ImageDomAdapter {
  /** Decode an image URL to a drawable with intrinsic dimensions. */
  loadImage(url: string): Promise<{ readonly width: number; readonly height: number; drawTo(surface: DrawSurface): void }>
  /** Allocate a draw surface of the given size. */
  createSurface(width: number, height: number): DrawSurface
}

/**
 * Browser adapter: `Image.decode()` plus an `OffscreenCanvas` 2D context.
 * Globals are read at call time so tests can stub them.
 * @returns the adapter.
 */
export function browserImageDom(): ImageDomAdapter {
  return {
    loadImage(url) {
      const img = new Image()
      img.src = url
      return img.decode().then(() => ({
        width: img.naturalWidth,
        height: img.naturalHeight,
        drawTo: (surface: DrawSurface) => {
          surface.drawImage(img, 0, 0)
        },
      }))
    },
    createSurface(width, height) {
      const canvas = new OffscreenCanvas(width, height)
      return canvas.getContext('2d') as DrawSurface
    },
  }
}

/**
 * Decode an image URL into a {@link PixelSource}.
 * @param url - image URL (same-origin or data URL).
 * @param dom - decoding adapter (default: {@link browserImageDom}).
 * @returns the decoded pixel source.
 */
export async function loadPixelSource(url: string, dom: ImageDomAdapter = browserImageDom()): Promise<PixelSource> {
  const img = await dom.loadImage(url)
  const surface = dom.createSurface(img.width, img.height)
  img.drawTo(surface)
  const data = surface.getImageData(0, 0, img.width, img.height).data
  const width = img.width
  return {
    width: img.width,
    height: img.height,
    pixel(x: number, y: number): Rgba {
      const i = (y * width + x) * 4
      return [data[i] as number, data[i + 1] as number, data[i + 2] as number, data[i + 3] as number]
    },
  }
}
