/**
 * Easing functions and trackers, ported from the ttfx Ruby port
 * (`ttfx/easing.rb`, itself from ttfx `src/utils/easing.rs`).
 * @module ui-primitives/ttfx/easing
 */

const PI = 3.141592653589793

/** CSS cubic-bezier control points accepted by {@link ease}. */
export type CubicBezierControl = readonly [number, number, number, number]

/** Named easings plus CSS cubic-bezier tuples. */
export type EasingName = string | CubicBezierControl

/**
 * Evaluate a named easing at progress `p` in [0, 1].
 * @param name - easing name (CLI spellings, e.g. `out_cubic`) or a
 *   `[x1, y1, x2, y2]` cubic-bezier control tuple.
 * @param p - progress in [0, 1].
 * @returns eased value in (approximately) [0, 1].
 */
export function ease(name: EasingName, p: number): number {
  if (typeof name !== 'string') return cubicBezier(name[0], name[1], name[2], name[3], p)
  switch (name) {
    case 'linear': return p
    case 'in_sine': return 1 - Math.cos((p * PI) / 2)
    case 'out_sine': return Math.sin((p * PI) / 2)
    case 'in_out_sine': return -(Math.cos(PI * p) - 1) / 2
    case 'in_quad': return p ** 2
    case 'out_quad': return 1 - (1 - p) * (1 - p)
    case 'in_out_quad':
      if (p < 0.5) return 2 * p ** 2
      return 1 - (-2 * p + 2) ** 2 / 2
    case 'in_cubic': return p ** 3
    case 'out_cubic': return 1 - (1 - p) ** 3
    case 'in_out_cubic':
      if (p < 0.5) return 4 * p ** 3
      return 1 - (-2 * p + 2) ** 3 / 2
    case 'in_quart': return p ** 4
    case 'out_quart': return 1 - (1 - p) ** 4
    case 'in_out_quart':
      if (p < 0.5) return 8 * p ** 4
      return 1 - (-2 * p + 2) ** 4 / 2
    case 'in_quint': return p ** 5
    case 'out_quint': return 1 - (1 - p) ** 5
    case 'in_out_quint':
      if (p < 0.5) return 16 * p ** 5
      return 1 - (-2 * p + 2) ** 5 / 2
    case 'in_expo':
      return p === 0 ? 0 : 2 ** (10 * p - 10)
    case 'out_expo':
      return p === 1 ? 1 : 1 - 2 ** (-10 * p)
    case 'in_out_expo':
      if (p === 0) return 0
      if (p === 1) return 1
      if (p < 0.5) return 2 ** (20 * p - 10) / 2
      return (2 - 2 ** (-20 * p + 10)) / 2
    case 'in_circ': return 1 - Math.sqrt(1 - p ** 2)
    case 'out_circ': return Math.sqrt(1 - (p - 1) ** 2)
    case 'in_out_circ':
      if (p < 0.5) return (1 - Math.sqrt(1 - (2 * p) ** 2)) / 2
      return (Math.sqrt(1 - (-2 * p + 2) ** 2) + 1) / 2
    case 'in_back': {
      const c1 = 1.70158
      const c3 = c1 + 1
      return c3 * p ** 3 - c1 * p ** 2
    }
    case 'out_back': {
      const c1 = 1.70158
      const c3 = c1 + 1
      return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2
    }
    case 'in_out_back': {
      const c1 = 1.70158
      const c2 = c1 * 1.525
      if (p < 0.5) return ((2 * p) ** 2 * ((c2 + 1) * 2 * p - c2)) / 2
      return ((2 * p - 2) ** 2 * ((c2 + 1) * (p * 2 - 2) + c2) + 2) / 2
    }
    case 'in_elastic': {
      const c4 = (2 * PI) / 3
      if (p === 0) return 0
      if (p === 1) return 1
      return -(2 ** (10 * p - 10)) * Math.sin((p * 10 - 10.75) * c4)
    }
    case 'out_elastic': {
      const c4 = (2 * PI) / 3
      if (p === 0) return 0
      if (p === 1) return 1
      return 2 ** (-10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1
    }
    case 'in_out_elastic': {
      const c5 = (2 * PI) / 4.5
      if (p === 0) return 0
      if (p === 1) return 1
      if (p < 0.5) return -(2 ** (20 * p - 10) * Math.sin((20 * p - 11.125) * c5)) / 2
      return (2 ** (-20 * p + 10) * Math.sin((20 * p - 11.125) * c5)) / 2 + 1
    }
    case 'in_bounce': return 1 - outBounce(1 - p)
    case 'out_bounce': return outBounce(p)
    case 'in_out_bounce':
      if (p < 0.5) return (1 - outBounce(1 - 2 * p)) / 2
      return (1 + outBounce(2 * p - 1)) / 2
    default: return p
  }
}

/**
 * Out-only bounce easing used by {@link ease} bounce variants.
 * @param p - progress in [0, 1].
 * @returns bounced value.
 */
export function outBounce(p: number): number {
  const n1 = 7.5625
  const d1 = 2.75
  if (p < 1 / d1) return n1 * p ** 2
  if (p < 2 / d1) return n1 * (p - 1.5 / d1) ** 2 + 0.75
  if (p < 2.5 / d1) return n1 * (p - 2.25 / d1) ** 2 + 0.9375
  return n1 * (p - 2.625 / d1) ** 2 + 0.984375
}

/**
 * CSS-style cubic-bezier easing: solve x(t) = progress by the same Newton
 * iteration and tolerances as the Rust engine.
 * @param x1 - first control x.
 * @param y1 - first control y.
 * @param x2 - second control x.
 * @param y2 - second control y.
 * @param progress - progress in [0, 1].
 * @returns eased y value.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, progress: number): number {
  if (progress <= 0) return 0
  if (progress >= 1) return 1
  let t = progress
  for (let i = 0; i < 20; i += 1) {
    const omt = 1 - t
    const x = 3 * x1 * omt * omt * t + 3 * x2 * omt * t * t + t * t * t
    const dx = x - progress
    if (Math.abs(dx) < 1e-5) break
    const deriv = 3 * omt * omt * x1 + 6 * omt * t * (x2 - x1) + 3 * t * t * (1 - x2)
    if (Math.abs(deriv) < 1e-6) break
    t -= dx / deriv
  }
  const omt = 1 - t
  return 3 * y1 * omt * omt * t + 3 * y2 * omt * t * t + t * t * t
}

/** Tracker names a clamped [0,1] eased step count. */
export interface EasingTrackerOptions {
  /** Easing name or cubic-bezier control tuple. */
  easeName: EasingName
  /** Total steps before the tracker reports complete. */
  totalSteps: number
  /** Clamp eased values to [0, 1]. */
  clamp: boolean
}

/**
 * Step counter with optional [0, 1] clamping; each {@link EasingTracker.step}
 * advances one step and exposes the eased value and per-step delta.
 */
export class EasingTracker {
  readonly #easeName: EasingName
  readonly #totalSteps: number
  readonly #clamp: boolean
  #currentStep = 0
  #easedValue = 0
  #lastEasedValue = 0
  #stepDelta = 0

  /** @param options - see {@link EasingTrackerOptions}. */
  constructor(options: EasingTrackerOptions) {
    this.#easeName = options.easeName
    this.#totalSteps = options.totalSteps
    this.#clamp = options.clamp
  }

  /** Eased value after the most recent step. */
  get easedValue(): number {
    return this.#easedValue
  }

  /** Difference between the last two eased values. */
  get stepDelta(): number {
    return this.#stepDelta
  }

  /** Advance one step; returns the eased value. */
  step(): number {
    if (this.#currentStep < this.#totalSteps) {
      this.#currentStep += 1
      this.#easedValue = ease(this.#easeName, this.#currentStep / this.#totalSteps)
      if (this.#clamp) {
        if (this.#easedValue > 1) this.#easedValue = 1
        if (this.#easedValue < 0) this.#easedValue = 0
      }
      this.#stepDelta = this.#easedValue - this.#lastEasedValue
      this.#lastEasedValue = this.#easedValue
    }
    return this.#easedValue
  }

  /** True once all steps have been taken. */
  get complete(): boolean {
    return this.#currentStep >= this.#totalSteps
  }

  /** Zero every counter and eased value. */
  reset(): void {
    this.#currentStep = 0
    this.#stepDelta = 0
    this.#easedValue = 0
    this.#lastEasedValue = 0
  }
}

/**
 * Sequence easer over an owned group sequence: each step reports the
 * added/removed slices implied by the int-truncated eased position
 * (never both at once).
 */
export class SequenceEaser {
  #sequence: number[][]
  readonly #tracker: EasingTracker

  /**
   * @param sequence - group sequence (arrays of character ids).
   * @param easeName - easing over the sequence.
   * @param totalSteps - steps to consume the whole sequence.
   */
  constructor(sequence: number[][], easeName: EasingName, totalSteps: number) {
    this.#sequence = sequence
    this.#tracker = new EasingTracker({ easeName, totalSteps, clamp: true })
  }

  /** True when the tracker consumed every step. */
  get complete(): boolean {
    return this.#tracker.complete
  }

  /**
   * Swap in a new group sequence and restart the tracker.
   * @param groups - replacement group sequence.
   */
  resequence(groups: number[][]): void {
    this.#sequence = groups
    this.#tracker.reset()
  }

  /**
   * Advance one step.
   * @returns `[added, removed]` slices of character ids.
   */
  step(): [number[][], number[][]] {
    const prev = this.#tracker.easedValue
    const eased = this.#tracker.step()
    const n = this.#sequence.length
    if (n === 0) return [[], []]
    const len = Math.trunc(eased * n)
    const prevLen = Math.trunc(prev * n)
    if (len > prevLen) return [this.#sequence.slice(prevLen, len), []]
    if (len < prevLen) return [[], this.#sequence.slice(len, prevLen)]
    return [[], []]
  }

  /** Reset the tracker to the start of the current sequence. */
  reset(): void {
    this.#tracker.reset()
  }
}
