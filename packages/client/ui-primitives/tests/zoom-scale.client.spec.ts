// @vitest-environment jsdom
// fixedInsetScale ground rules: the product of computed zoom from the element
// through the root, skipping non-numeric entries, defaulting to 1. jsdom has
// no zoom engine, so computed zoom is stubbed per element.

import { describe, expect, it, vi } from 'vitest'
import { fixedInsetScale } from '../src/zoom-scale.ts'

function stubZoom(zoomByKey: Map<string, string>): void {
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
    const key = el instanceof Element ? (el.id !== '' ? `#${el.id}` : el.tagName) : ''
    return { zoom: zoomByKey.get(key) ?? '' } as unknown as CSSStyleDeclaration
  })
}

describe('fixedInsetScale', () => {
  it('returns 1 for a null element', () => {
    expect(fixedInsetScale(null)).toBe(1)
  })

  it('multiplies the element zoom with every zoomed ancestor', () => {
    document.body.innerHTML = `
      <div id="root"><div id="pane"><span id="leaf">leaf</span></div></div>`
    stubZoom(new Map([['#leaf', '1.25'], ['#pane', '1.2']]))
    const leaf = document.getElementById('leaf')!
    expect(fixedInsetScale(leaf)).toBeCloseTo(1.5)
  })

  it('ignores non-numeric and non-positive zoom entries', () => {
    document.body.innerHTML = '<div id="pane"><span id="leaf">leaf</span></div>'
    stubZoom(new Map([['#leaf', 'not-a-number'], ['#pane', '0']]))
    const leaf = document.getElementById('leaf')!
    expect(fixedInsetScale(leaf)).toBe(1)
  })
})
