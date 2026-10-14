import { describe, expect, it } from 'vitest'
import { RANDbelow_MAX, Rng } from '../src/ttfx/rng.ts'
import { roundHalfEven, trunc } from '../src/ttfx/pycompat.ts'

describe('ttfx RNG compatibility', () => {
  it("covers banker's rounding and truncation toward zero", () => {
    expect(roundHalfEven(2.5)).toBe(2)
    expect(roundHalfEven(3.5)).toBe(4)
    expect(roundHalfEven(-2.5)).toBe(-2)
    expect(roundHalfEven(-3.5)).toBe(-4)
    expect(roundHalfEven(2.2)).toBe(2)
    expect(roundHalfEven(2.8)).toBe(3)
    expect(trunc(2.9)).toBe(2)
    expect(trunc(-2.9)).toBe(-2)
  })

  it('bounds integers, rejects invalid ranges, and covers rejection sampling', () => {
    const rng = new Rng(9)
    expect(rng.randbelow(1)).toBe(0)
    expect(rng.randint(4, 4)).toBe(4)
    expect(rng.randrange(5, 6)).toBe(5)
    expect(rng.randbelow(RANDbelow_MAX)).toBeGreaterThanOrEqual(0)
    expect(() => rng.randbelow(0)).toThrow(RangeError)
    expect(() => rng.randbelow(-1)).toThrow(RangeError)
    expect(() => rng.randbelow(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => rng.randrange(4, 4)).toThrow(RangeError)
    expect(() => rng.choiceIndex(0)).toThrow(RangeError)
    expect(() => rng.choice([])).toThrow(RangeError)

    let seed = 0
    let accepted: number
    for (; seed < 1000; seed += 1) {
      const probe = new Rng(seed)
      const first = probe.randbelow(RANDbelow_MAX)
      const second = probe.randbelow(RANDbelow_MAX)
      const firstHigh = Math.floor(first / 2 ** 51)
      const secondHigh = Math.floor(second / 2 ** 51)
      if (firstHigh === 3 && secondHigh < 3) {
        accepted = secondHigh
        break
      }
    }
    expect(seed).toBeLessThan(1000)
    expect(new Rng(seed).randbelow(3)).toBe(accepted)
  })

  it('chooses, shuffles, draws floats, and wraps seed words to 64 bits', () => {
    expect(new Rng(1).choice(['only'])).toBe('only')
    const empty: number[] = []
    const one = [1]
    expect(new Rng(1).shuffle(empty)).toBe(empty)
    expect(new Rng(1).shuffle(one)).toEqual([1])
    expect(new Rng(42).shuffle([1, 2, 3, 4, 5])).not.toEqual([1, 2, 3, 4, 5])
    const value = new Rng(55).random()
    expect(value).toBeGreaterThanOrEqual(0)
    expect(value).toBeLessThan(1)
    expect(new Rng(55).uniform(3, 3)).toBe(3)
    const base = new Rng(8n)
    const wrapped = new Rng(8n + (1n << 64n))
    expect(Array.from({ length: 4 }, () => base.randbelow(100))).toEqual(
      Array.from({ length: 4 }, () => wrapped.randbelow(100)),
    )
    const sequence = [1, 2, 3]
    const shuffled = new Rng(12).shuffle(sequence)
    expect(shuffled).toBe(sequence)
    expect([...shuffled].sort()).toEqual([1, 2, 3])
  })
})
