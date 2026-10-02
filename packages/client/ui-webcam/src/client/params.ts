/**
 * Pure mapping from shared settings to compositor render parameters: the
 * slider-to-kernel scaling, effect enumeration, and color selection the
 * shaders consume. Unit-tested directly; the compositor consumes the output
 * verbatim so the mapping has exactly one home.
 * @module @deepseek-ai/dsh-client-ui-webcam/client/params
 */

import { BACKDROPS, REMOVE_COLORS, backdropAt } from './backdrops.js'
import type { WebcamSettingsState } from './settings.js'

/** Effect codes for the composite shader's `uEffect` uniform. */
export const EFFECT_CODE = { off: 0, remove: 1, blur: 2, replace: 3 } as const

/** Gaussian blur radius, in quarter-res texels, at the slider extremes. */
export const BLUR_RADIUS_RANGE = { min: 0.75, max: 6 } as const

/** Mask feather width, in mask texels (256-wide mask space). */
export const FEATHER_PX = 1.6

/** Everything one composited frame's shader pass consumes. */
export interface RenderParams {
  /** `uEffect`: 0 off, 1 remove, 2 blur, 3 replace. */
  effect: number
  /** `uBlurPx`: quarter-res gaussian radius for the background passes. */
  blurPx: number
  /** `uFeather`: mask-space feather width in texels. */
  feather: number
  /** `uRemoveColor`: the remove effect's solid color, linear RGB. */
  removeColor: readonly [number, number, number]
  /** Replace backdrop stops; undefined switches the shader to image mode. */
  backdropStops: readonly [readonly [number, number, number], readonly [number, number, number]] | undefined
  /** `uMirror`: flip the frame horizontally. */
  mirror: boolean
}

/**
 * Map settings onto render parameters.
 * @param settings - the shared settings snapshot.
 * @returns the render parameters for one composited frame.
 */
export function renderParams(settings: WebcamSettingsState): RenderParams {
  const t = settings.blurStrength / 100
  const blurPx = BLUR_RADIUS_RANGE.min + (BLUR_RADIUS_RANGE.max - BLUR_RADIUS_RANGE.min) * t
  return {
    effect: EFFECT_CODE[settings.effect],
    blurPx,
    feather: FEATHER_PX,
    removeColor: REMOVE_COLORS[settings.removeStyle],
    backdropStops: settings.effect === 'replace' && settings.backdropIndex < BACKDROPS.length
      ? (() => {
        const backdrop = backdropAt(settings.backdropIndex)
        return [backdrop.top, backdrop.bottom] as const
      })()
      : undefined,
    mirror: settings.mirror,
  }
}
