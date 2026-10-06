// @vitest-environment jsdom
// Menu portal placement under interface zoom: the portaled list carries the
// interface zoom itself, and the engine multiplies a zoomed fixed element's
// insets by that factor — placement must divide true viewport coordinates by
// the list's inset scale so the painted list lands on the anchor.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

const items = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
]

describe('Menu portal placement', () => {
  it('places the list at the anchor and divides the insets by the zoom factor', () => {
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      // The anchor wrapper measures at viewport (100, 50); the list itself is
      // irrelevant here (jsdom offsetWidth 0 keeps the clamp out of the math).
      return this.tagName === 'SPAN'
        ? { left: 100, right: 128, top: 50, bottom: 70, width: 28, height: 20, x: 100, y: 50, toJSON: () => ({}) }
        : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
    })
    // Only the portaled list carries zoom (its .portal sheet); ancestors stay
    // unzoomed in jsdom, so the walk must read 1.25 exactly once.
    const styleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      const zoomed = el instanceof Element && el.className.includes('portal')
      return { zoom: zoomed ? '1.25' : '' } as unknown as CSSStyleDeclaration
    })
    try {
      render(
        <Menu open portal anchor={<span>trigger</span>} items={items} onSelect={() => {}} onClose={() => {}} />,
      )
      const list = screen.getByRole('menu')
      // Drawn position: x = 100 (align start), y = 70 + 4 (side bottom);
      // insets divide by 1.25 so the painted list lands at (100, 74).
      expect(list.style.left).toBe('80px')
      expect(list.style.top).toBe('59.2px')
    } finally {
      rectSpy.mockRestore()
      styleSpy.mockRestore()
    }
  })
})
