import { describe, expect, it } from 'vitest'
import { BACKDROPS, backdropAt, backdropCss } from '../src/client/backdrops.js'
import { BLUR_RADIUS_RANGE, EFFECT_CODE, renderParams } from '../src/client/params.js'
import { WEBCAM_SETTINGS_DEFAULTS } from '../src/client/settings.js'

const CUSTOM_IMAGE_INDEX = BACKDROPS.length

describe('backdrops', () => {
  it('ships a non-empty built-in list with distinct ids', () => {
    expect(BACKDROPS.length).toBeGreaterThanOrEqual(4)
    expect(new Set(BACKDROPS.map(b => b.id)).size).toBe(BACKDROPS.length)
  })

  it('backdropAt clamps stale indices into range', () => {
    expect(backdropAt(-1)).toBe(BACKDROPS[0])
    expect(backdropAt(999)).toBe(BACKDROPS[BACKDROPS.length - 1])
    expect(backdropAt(2)).toBe(BACKDROPS[2])
  })

  it('backdropCss renders an 8-bit linear-gradient matching the stops orientation', () => {
    const css = backdropCss(BACKDROPS[0]!)
    expect(css).toMatch(/^linear-gradient\(to bottom, rgb\(\d+ \d+ \d+\), rgb\(\d+ \d+ \d+\)\)$/)
    const top = BACKDROPS[0]!.top.map(v => Math.round(v * 255))
    expect(css).toContain(`rgb(${top.join(' ')})`)
  })
})

describe('renderParams', () => {
  it('maps effects onto the shader effect codes', () => {
    expect(EFFECT_CODE).toEqual({ off: 0, remove: 1, blur: 2, replace: 3 })
    for (const effect of ['off', 'remove', 'blur', 'replace'] as const) {
      expect(renderParams({ ...WEBCAM_SETTINGS_DEFAULTS, effect }).effect).toBe(EFFECT_CODE[effect])
    }
  })

  it('maps the blur slider onto the quarter-res radius range', () => {
    expect(renderParams({ ...WEBCAM_SETTINGS_DEFAULTS, blurStrength: 0 }).blurPx).toBeCloseTo(BLUR_RADIUS_RANGE.min)
    expect(renderParams({ ...WEBCAM_SETTINGS_DEFAULTS, blurStrength: 100 }).blurPx).toBeCloseTo(BLUR_RADIUS_RANGE.max)
    expect(renderParams({ ...WEBCAM_SETTINGS_DEFAULTS, blurStrength: 50 }).blurPx)
      .toBeCloseTo((BLUR_RADIUS_RANGE.min + BLUR_RADIUS_RANGE.max) / 2)
  })

  it('remove picks the solid color and carries no backdrop stops', () => {
    const studio = renderParams({ ...WEBCAM_SETTINGS_DEFAULTS, effect: 'remove', removeStyle: 'studio' })
    expect(studio.backdropStops).toBeUndefined()
    expect(studio.removeColor).toEqual([0.10, 0.11, 0.14])
    const green = renderParams({ ...WEBCAM_SETTINGS_DEFAULTS, effect: 'remove', removeStyle: 'green' })
    expect(green.removeColor).toEqual([0.00, 0.69, 0.25])
  })

  it('replace with a built-in index carries gradient stops; the custom index switches to image mode', () => {
    const builtIn = renderParams({ ...WEBCAM_SETTINGS_DEFAULTS, effect: 'replace', backdropIndex: 0 })
    expect(builtIn.backdropStops).toEqual([BACKDROPS[0]!.top, BACKDROPS[0]!.bottom])
    const custom = renderParams({ ...WEBCAM_SETTINGS_DEFAULTS, effect: 'replace', backdropIndex: CUSTOM_IMAGE_INDEX })
    expect(custom.backdropStops).toBeUndefined()
  })

  it('carries the mirror flag verbatim', () => {
    expect(renderParams({ ...WEBCAM_SETTINGS_DEFAULTS, mirror: true }).mirror).toBe(true)
    expect(renderParams({ ...WEBCAM_SETTINGS_DEFAULTS, mirror: false }).mirror).toBe(false)
  })
})
