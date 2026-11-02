/**
 * Deterministic xoshiro256++ RNG with SplitMix64 seeding, ported from the
 * ttfx Ruby port (`ttfx/rng.rb`, itself a port of ttfx `src/utils/rng.rs`).
 * Same seed → same draw sequence, so effect frames are reproducible in
 * tests and QA dumps.
 * @module ui-primitives/ttfx/rng
 */

const U64_MASK = 0xffff_ffff_ffff_ffffn
const SPLITMIX_GAMMA = 0x9e37_79b9_7f4a_7c15n
const SPLITMIX_MUL1 = 0xbf58_476d_1ce4_e5b9n
const SPLITMIX_MUL2 = 0x94d0_49bb_1331_11ebn
/** Largest count `randbelow` accepts while staying exact in Number space. */
export const RANDbelow_MAX = 2 ** 53

/** Mask a BigInt to 64 bits. */
const u64 = (v: bigint): bigint => v & U64_MASK

/** Rotate-left a 64-bit BigInt. */
const rotl64 = (x: bigint, k: number): bigint => u64((x << BigInt(k)) | (x >> BigInt(64 - k)))

/**
 * Seeded xoshiro256++ generator. All draw methods take and return plain
 * numbers; internal 64-bit state arithmetic uses BigInt for exactness.
 */
export class Rng {
  #s0: bigint
  #s1: bigint
  #s2: bigint
  #s3: bigint

  /**
   * @param seed - non-negative seed (values above 2^64 wrap modulo 2^64).
   */
  constructor(seed: number | bigint) {
    const sm = u64(BigInt(seed))
    this.#s0 = Rng.#splitmixNext(sm)
    this.#s1 = Rng.#splitmixNext(sm)
    this.#s2 = Rng.#splitmixNext(sm)
    this.#s3 = Rng.#splitmixNext(sm)
  }

  /** SplitMix64: expand the seed into the four xoshiro state words. */
  static #splitmixNext(state: bigint): bigint {
    const next = u64(state + SPLITMIX_GAMMA)
    state = next
    let z = state
    z = u64(z ^ (z >> 30n))
    z = u64(z * SPLITMIX_MUL1)
    z = u64(z ^ (z >> 27n))
    z = u64(z * SPLITMIX_MUL2)
    z = u64(z ^ (z >> 31n))
    return z
  }

  /** Core xoshiro256++ step; returns the raw 64-bit output word. */
  #nextWord(): bigint {
    const r = u64(rotl64(u64(this.#s0 + this.#s3), 23) + this.#s0)
    const t = u64(this.#s1 << 17n)
    this.#s2 = u64(this.#s2 ^ this.#s0)
    this.#s3 = u64(this.#s3 ^ this.#s1)
    this.#s1 = u64(this.#s1 ^ this.#s2)
    this.#s0 = u64(this.#s0 ^ this.#s3)
    this.#s2 = u64(this.#s2 ^ t)
    this.#s3 = rotl64(this.#s3, 45)
    return r
  }

  /**
   * Uniform integer in [0, n) by bitmask rejection.
   * @param n - exclusive upper bound, 1 ≤ n ≤ 2^53.
   * @returns uniform integer below `n`.
   */
  randbelow(n: number): number {
    if (n <= 0 || n > RANDbelow_MAX) throw new RangeError(`randbelow out of range: ${n}`)
    const bl = Math.max(1, (n - 1).toString(2).length)
    const shift = BigInt(64 - bl)
    for (;;) {
      const v = Number(this.#nextWord() >> shift)
      if (v < n) return v
    }
  }

  /**
   * Uniform integer in [a, b] inclusive.
   * @param a - inclusive lower bound.
   * @param b - inclusive upper bound (≥ a).
   * @returns uniform integer between `a` and `b`.
   */
  randint(a: number, b: number): number {
    return a + this.randbelow(b - a + 1)
  }

  /**
   * Uniform integer in [a, b) half-open.
   * @param a - inclusive lower bound.
   * @param b - exclusive upper bound (> a).
   * @returns uniform integer below `b`.
   */
  randrange(a: number, b: number): number {
    return a + this.randbelow(b - a)
  }

  /**
   * Index of a uniformly chosen sequence element.
   * @param n - sequence length.
   * @returns uniform index in [0, n).
   */
  choiceIndex(n: number): number {
    return this.randbelow(n)
  }

  /**
   * Uniformly chosen element of a sequence.
   * @param seq - non-empty sequence.
   * @returns one element of `seq`.
   */
  choice<T>(seq: readonly T[]): T {
    return seq[this.randbelow(seq.length)] as T
  }

  /**
   * In-place Fisher-Yates shuffle from the top (Python `random.shuffle`).
   * @param seq - array shuffled in place.
   * @returns the same array.
   */
  shuffle<T>(seq: T[]): T[] {
    let i = seq.length - 1
    while (i >= 1) {
      const j = this.randbelow(i + 1)
      const tmp = seq[i] as T
      seq[i] = seq[j] as T
      seq[j] = tmp
      i -= 1
    }
    return seq
  }

  /**
   * Python `random.random()`: float in [0, 1) with 53 bits of entropy.
   * @returns uniform float in [0, 1).
   */
  random(): number {
    const w = this.#nextWord()
    const hi = ((w >> 32n) & 0xffffn) + (((w >> 48n) & 0xffffn) << 16n)
    const lo = (w & 0xffffn) + (((w >> 16n) & 0xffffn) << 16n)
    const v = (hi << 21n) | (lo >> 11n)
    return Number(v) / 9007199254740992
  }

  /**
   * Uniform float in [a, b).
   * @param a - lower bound.
   * @param b - upper bound.
   * @returns uniform float between `a` and `b`.
   */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random()
  }
}
