/**
 * Mask-side image processing that runs on the 2D canvas (no GL): converting
 * the segmenter's person-confidence plane into a person-alpha frame, and the
 * temporal exponential-moving-average that stabilizes the mask across frames
 * (NVIDIA-Broadcast-style flicker suppression). The stabilized canvas is
 * shared read-only with every mounted view; spatial feathering happens
 * per-view in the composite shader.
 * @module @deepseek-ai/dsh-client-ui-webcam/client/mask
 */

/** Side length of the square mask plane (the model's native output size). */
export const MASK_SIZE = 256

/** Weight of the NEW frame in the temporal EMA (0–1); higher tracks faster, flickers more. */
export const MASK_EMA_ALPHA = 0.4

/**
 * Convert one person-confidence plane into RGBA bytes whose red channel
 * carries person alpha (the confidence directly — the selfie segmenter's
 * person mask, not an inverted background). Other channels mirror the alpha
 * so any sampling channel works. Reads past the plane's end (a short plane)
 * fall back to 0 — erased, never fabricated person.
 * @param confidence - row-major person confidence in [0,1], MASK_SIZE² floats.
 * @returns RGBA bytes for one `MASK_SIZE×MASK_SIZE` ImageData.
 */
export function personAlphaFromConfidence(confidence: Float32Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(MASK_SIZE * MASK_SIZE * 4)
  for (let i = 0; i < MASK_SIZE * MASK_SIZE; i += 1) {
    const alpha = Math.round(255 * Math.min(1, Math.max(0, confidence[i] ?? 0)))
    const o = i * 4
    out[o] = alpha
    out[o + 1] = alpha
    out[o + 2] = alpha
    out[o + 3] = alpha
  }
  return out
}

/**
 * Scratch canvas type: OffscreenCanvas where available (workers-friendly,
 * no DOM node), else a detached canvas element. Both draw via 2D context.
 */
export type MaskCanvas = OffscreenCanvas | HTMLCanvasElement

/**
 * Acquire a 2D context from either scratch canvas kind. The union's
 * `getContext` overload widens the return to every rendering context
 * (including the unblendable `ImageBitmapRenderingContext`); both concrete
 * kinds answer `'2d'` with a blendable 2D context, so one narrowing
 * assertion covers the union.
 * @param canvas - the scratch canvas to bind.
 * @returns the 2D context.
 */
function ctx2d(canvas: MaskCanvas): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (ctx === null) throw new Error('webcam: 2D context unavailable for mask stabilization')
  return ctx
}

function createCanvas(size: number): MaskCanvas {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(size, size)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  return canvas
}

/**
 * The blend weight one push applies: the first frame seeds at full opacity,
 * every later frame blends at the EMA weight.
 * @param seeded - whether the stabilizer already holds history.
 * @returns the globalAlpha the push draws the new frame with.
 */
export function stabilizeAlpha(seeded: boolean): number {
  return seeded ? MASK_EMA_ALPHA : 1
}

/**
 * Temporal EMA stabilizer: `push` blends each new mask frame over the
 * previous content (`stable ← stable·(1−α) + new·α`, first frame at α=1) and
 * exposes the blended result as a canvas the compositor uploads per frame.
 */
export class MaskStabilizer {
  /** The stabilized mask, R = person alpha. Consumers read, never write. */
  readonly canvas: MaskCanvas

  readonly #scratch: MaskCanvas
  readonly #stableCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  readonly #scratchCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  #seeded = false

  constructor() {
    this.canvas = createCanvas(MASK_SIZE)
    this.#scratch = createCanvas(MASK_SIZE)
    this.#stableCtx = ctx2d(this.canvas)
    this.#scratchCtx = ctx2d(this.#scratch)
  }

  /**
   * Blend one new person-alpha frame into the stabilized canvas.
   * @param frame - RGBA bytes from {@link personAlphaFromConfidence}.
   */
  push(frame: Uint8ClampedArray<ArrayBuffer>): void {
    this.#scratchCtx.putImageData(new ImageData(frame, MASK_SIZE, MASK_SIZE), 0, 0)
    this.#stableCtx.save()
    this.#stableCtx.globalAlpha = stabilizeAlpha(this.#seeded)
    this.#stableCtx.drawImage(this.#scratch, 0, 0)
    this.#stableCtx.restore()
    this.#seeded = true
  }

  /** Drop the accumulated history — the next push reseeds at full opacity. */
  reset(): void {
    this.#seeded = false
  }
}
