/**
 * RGB colors and floor-division gradients, ported from the ttfx Ruby port
 * (`ttfx/color.rb`, itself from ttfx `src/utils/graphics.rs`).
 * The gradient spectrum is NOT float lerp: channel deltas use integer floor
 * division and the exact end stop is appended per pair.
 * @module ui-primitives/ttfx/color
 */

import { roundHalfEven } from './pycompat.ts'

/** RGB color as an integer triple, 0..255 per channel. */
export type Rgb = readonly [number, number, number]

/** Clamp one channel into 0..255. */
const clampChannel = (v: number): number => {
  if (v < 0) return 0
  if (v > 255) return 255
  return v
}

/** Ruby/Python floor division (rounds toward negative infinity). */
const floorDiv = (a: number, b: number): number => Math.floor(a / b)

/**
 * Parse a `#rrggbb` / `rrggbb` hex color (a 7-digit input parses its first
 * six digits — upstream quirk preserved).
 * @param hex - hex color string.
 * @returns the RGB triple, or null when the string is not valid hex.
 */
export function fromHex(hex: string): Rgb | null {
  const s = hex.startsWith('#') ? hex.slice(1) : hex
  if (s.length !== 6 && s.length !== 7) return null
  const pair = (i: number): number | null => {
    const h = Number.parseInt(s.charAt(i), 16)
    const l = Number.parseInt(s.charAt(i + 1), 16)
    return Number.isNaN(h) || Number.isNaN(l) ? null : h * 16 + l
  }
  const r = pair(0)
  const g = pair(2)
  const b = pair(4)
  return r === null || g === null || b === null ? null : [r, g, b]
}

/**
 * HSL lightness scale of a color (upstream `adjust_color_brightness`).
 * @param c - color to adjust.
 * @param brightness - lightness multiplier.
 * @returns adjusted color.
 */
export function adjustBrightness(c: Rgb, brightness: number): Rgb {
  const nr = c[0] / 255
  const ng = c[1] / 255
  const nb = c[2] / 255
  const mx = Math.max(nr, ng, nb)
  const mn = Math.min(nr, ng, nb)
  let light = (mx + mn) / 2
  let hue = 0
  let sat = 0
  if (mx !== mn) {
    const diff = mx - mn
    sat = light > 0.5 ? diff / (2 - mx - mn) : diff / (mx + mn)
    if (mx === nr) {
      hue = (ng - nb) / diff
      if (ng < nb) hue += 6
    } else if (mx === ng) {
      hue = (nb - nr) / diff + 2
    } else {
      hue = (nr - ng) / diff + 4
    }
    hue /= 6
  }
  light = Math.min(1, Math.max(0, light * brightness))
  let r: number
  let g: number
  let b: number
  if (sat === 0) {
    r = light
    g = light
    b = light
  } else {
    const ci = light < 0.5 ? light * (1 + sat) : light + sat - light * sat
    const ls = 2 * light - ci
    const hueToRgb = (h: number): number => {
      const hh = h < 0 ? h + 1 : h > 1 ? h - 1 : h
      if (hh < 1 / 6) return ls + (ci - ls) * 6 * hh
      if (hh < 1 / 2) return ci
      if (hh < 2 / 3) return ls + (ci - ls) * (2 / 3 - hh) * 6
      return ls
    }
    r = hueToRgb(hue + 1 / 3)
    g = hueToRgb(hue)
    b = hueToRgb(hue - 1 / 3)
  }
  return [roundHalfEven(r * 255), roundHalfEven(g * 255), roundHalfEven(b * 255)]
}

/** Radial-fraction inputs for {@link Gradient.coordMap}. */
export type GradientDirection = 'vertical' | 'horizontal' | 'diagonal' | 'radial'

/**
 * Discrete gradient spectrum with the exact integer stepping semantics of
 * the upstream engine, plus the boundary-exact fraction lookup and the
 * coordinate → color mapping used by effects. The spectrum is non-empty
 * by contract (see {@link Gradient.build}).
 */
export class Gradient {
  readonly spectrum: Rgb[]

  /** @param spectrum - precomputed color list (see {@link Gradient.build}). */
  constructor(spectrum: Rgb[]) {
    this.spectrum = spectrum
  }

  /**
   * Build a spectrum from color stops and per-pair integer step counts.
   * @param stops - color stops (≥ 1).
   * @param steps - one step count per stop pair; a shorter list repeats its
   *   last entry; empty is invalid (pass a single step count instead).
   * @param stepsWasInt - true when `steps` came from a single int (validates
   *   every entry > 0); false skips the per-entry validation the CLI does.
   * @param doLoop - append the first stop so the gradient cycles.
   * @returns the built gradient.
   */
  static build(stops: readonly Rgb[], steps: readonly number[], stepsWasInt: boolean, doLoop: boolean): Gradient {
    if (stops.length === 0) throw new Error('At least one stop must be provided.')
    if (steps.length === 0) throw new Error('At least one step count must be provided.')
    if (stepsWasInt) {
      for (const st of steps) {
        if (st < 1) throw new Error('Steps must be greater than 0.')
      }
    }
    if (stops.length === 1) {
      const first = stops[0] as Rgb
      const singleSteps = steps[0] as number
      const spec: Rgb[] = []
      for (let i = 0; i < singleSteps; i += 1) spec.push([first[0], first[1], first[2]])
      return new Gradient(spec)
    }
    const sts: Rgb[] = [...stops]
    if (doLoop) sts.push(stops[0] as Rgb)
    const pairCount = sts.length - 1
    const stps = steps.slice(0, pairCount)
    while (stps.length < pairCount) stps.push(stps[stps.length - 1] as number)
    const spec: Rgb[] = []
    for (let p = 0; p < pairCount; p += 1) {
      const sc = stps[p] as number
      if (sc < 1) throw new Error(`Invalid steps: ${sc} | Steps must be greater than 0.`)
      const s = sts[p] as Rgb
      const e = sts[p + 1] as Rgb
      const dr = floorDiv(e[0] - s[0], sc)
      const dg = floorDiv(e[1] - s[1], sc)
      const db = floorDiv(e[2] - s[2], sc)
      for (let i = spec.length === 0 ? 0 : 1; i < sc; i += 1) {
        spec.push([clampChannel(s[0] + dr * i), clampChannel(s[1] + dg * i), clampChannel(s[2] + db * i)])
      }
      spec.push([e[0], e[1], e[2]])
    }
    return new Gradient(spec)
  }

  /**
   * Single-step-count convenience for {@link Gradient.build}.
   * @param stops - color stops (≥ 1).
   * @param steps - steps per pair.
   * @param doLoop - append the first stop so the gradient cycles.
   * @returns the built gradient.
   */
  static withSteps(stops: readonly Rgb[], steps: number, doLoop: boolean): Gradient {
    return Gradient.build(stops, [steps], true, doLoop)
  }

  /**
   * First spectrum index in 1..=len whose boundary fraction covers
   * `fraction` (boundary-exact, mirrors upstream).
   * @param fraction - lookup fraction in [0, 1].
   * @returns the spectrum color covering `fraction`.
   */
  colorAtFraction(fraction: number): Rgb {
    if (this.spectrum.length === 0) throw new Error('Gradient spectrum is empty.')
    if (fraction < 0 || fraction > 1) throw new RangeError('Fraction must be 0 <= fraction <= 1.')
    const len = this.spectrum.length
    let idx = Math.min(Math.trunc(fraction * len), len - 1)
    while (idx > 0 && fraction <= idx / len) idx -= 1
    /* v8 ignore next -- The floored index and prior boundary correction leave no valid fraction below its next boundary. */
    while (idx + 1 < len && fraction > (idx + 1) / len) idx += 1
    return this.spectrum[idx] as Rgb
  }

  /**
   * Coordinate → color mapping over an inclusive rectangle.
   * @param minRow - first row (≥ 1).
   * @param maxRow - last row (≥ minRow).
   * @param minCol - first column (≥ minCol).
   * @param maxCol - last column (≥ minCol).
   * @param direction - gradient direction over the rectangle.
   * @returns the coordinate lookup.
   */
  coordMap(minRow: number, maxRow: number, minCol: number, maxCol: number, direction: GradientDirection): GradientMap {
    if (maxRow < 1 || maxCol < 1) throw new Error('max_row and max_column must be greater than 0.')
    if (minRow > maxRow || minCol > maxCol) throw new Error('min must be <= max.')
    const rowOff = minRow - 1
    const colOff = minCol - 1
    const columnMajor = direction === 'horizontal'
    const width = maxCol - minCol + 1
    const height = maxRow - minRow + 1
    const colors: Rgb[] = []
    if (direction === 'vertical') {
      for (let r = minRow; r <= maxRow; r += 1) {
        const c = this.colorAtFraction((r - rowOff) / (maxRow - rowOff))
        for (let col = minCol; col <= maxCol; col += 1) colors.push(c)
      }
    } else if (direction === 'horizontal') {
      for (let col = minCol; col <= maxCol; col += 1) {
        const c = this.colorAtFraction((col - colOff) / (maxCol - colOff))
        for (let r = minRow; r <= maxRow; r += 1) colors.push(c)
      }
    } else if (direction === 'diagonal') {
      for (let r = minRow; r <= maxRow; r += 1) {
        for (let col = minCol; col <= maxCol; col += 1) {
          const frac = ((r - rowOff) * 2 + (col - colOff)) / ((maxRow - rowOff) * 2 + (maxCol - colOff))
          colors.push(this.colorAtFraction(frac))
        }
      }
    } else {
      for (let r = minRow; r <= maxRow; r += 1) {
        for (let col = minCol; col <= maxCol; col += 1) {
          colors.push(this.colorAtFraction(Gradient.radialFraction(minRow, maxRow, minCol, maxCol, col, r)))
        }
      }
    }
    return new GradientMap(minRow, minCol, width, height, columnMajor, colors)
  }

  /**
   * Normalized center distance of a cell (radial gradient fraction).
   * @param bottom - text bottom row.
   * @param top - text top row.
   * @param left - text left column.
   * @param right - text right column.
   * @param col - cell column.
   * @param row - cell row.
   * @returns fraction in [0, ∞) scaled by half the rectangle diagonal.
   */
  static radialFraction(bottom: number, top: number, left: number, right: number, col: number, row: number): number {
    const yoff = bottom - 1
    const xoff = left - 1
    const rw = right - xoff
    const th = top - yoff
    const cx = rw / 2
    const cy = th / 2
    const c = col - xoff
    const r = row - yoff
    const maxd = Math.sqrt(rw ** 2 + (th * 2) ** 2)
    const dist = Math.sqrt((c - cx) ** 2 + ((r - cy) * 2) ** 2)
    return dist / (maxd / 2)
  }
}

/** Insertion-ordered coordinate → color lookup over a dense rectangle. */
export class GradientMap {
  readonly #minRow: number
  readonly #minCol: number
  readonly #width: number
  readonly #height: number
  readonly #columnMajor: boolean
  readonly #colors: Rgb[]

  /** @see {@link Gradient.coordMap} for parameter semantics. */
  constructor(minRow: number, minCol: number, width: number, height: number, columnMajor: boolean, colors: Rgb[]) {
    this.#minRow = minRow
    this.#minCol = minCol
    this.#width = width
    this.#height = height
    this.#columnMajor = columnMajor
    this.#colors = colors
  }

  /**
   * Color at a coordinate.
   * @param col - cell column.
   * @param row - cell row.
   * @returns the mapped color, or null outside the mapped rectangle.
   */
  get(col: number, row: number): Rgb | null {
    const c = col - this.#minCol
    const r = row - this.#minRow
    if (c < 0 || r < 0 || c >= this.#width || r >= this.#height) return null
    const idx = this.#columnMajor ? c * this.#height + r : r * this.#width + c
    return this.#colors[idx] ?? null
  }
}
