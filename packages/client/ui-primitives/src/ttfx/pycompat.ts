/**
 * Deterministic RNG helpers shared by the ttfx port.
 * @module ui-primitives/ttfx/pycompat
 */

/**
 * Python `round()`-compatible banker's rounding to an integer
 * (half-way cases round to the even neighbor; negative floats floor first).
 * @param x - value to round.
 * @returns nearest integer, ties to even.
 */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d < 0.5) return f
  if (d > 0.5) return f + 1
  return f % 2 === 0 ? f : f + 1
}

/**
 * Truncate toward zero (Python `int()` on floats).
 * @param x - value to truncate.
 * @returns the integer part of `x`.
 */
export function trunc(x: number): number {
  return Math.trunc(x)
}
