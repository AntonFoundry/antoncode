// @vitest-environment jsdom
/** Real Mermaid parsing and SVG ownership; jsdom geometry is not visual evidence. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { MermaidDiagram } from '../src/markdown/mermaid.tsx'

const labels = {
  rendering: 'Rendering', failed: 'Failed', copyImage: 'Copy image', copied: 'Copied',
  copiedFailed: 'Download', zoomIn: 'Zoom in', zoomOut: 'Zoom out', resetZoom: 'Reset zoom',
  copySource: 'Copy source', copiedSource: 'Source copied', fullscreen: 'Fullscreen', exitFullscreen: 'Exit fullscreen',
}
let originalScheme: string
let originalBBox: PropertyDescriptor | undefined

beforeEach(() => {
  originalScheme = document.documentElement.style.colorScheme
  document.documentElement.style.colorScheme = 'light'
  originalBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox')
  // Mermaid needs SVG layout; jsdom supplies DOM parsing but no geometry engine.
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 100, height: 40 }),
  })
})
afterEach(() => {
  cleanup()
  document.documentElement.style.colorScheme = originalScheme
  if (originalBBox === undefined) Reflect.deleteProperty(SVGElement.prototype, 'getBBox')
  else Object.defineProperty(SVGElement.prototype, 'getBBox', originalBBox)
  vi.restoreAllMocks()
})

it('keeps real mounted SVGs after a later parse failure, theme changes, and another card unmounts', async () => {
  const first = render(<MermaidDiagram code="graph TD; alpha-->beta" copyLabel="Copy" copiedLabel="Copied" labels={labels} />)
  await waitFor(() => { expect(first.container.querySelector('[data-mermaid="ready"]')).not.toBeNull() })
  const second = render(<MermaidDiagram code="graph TD; alpha-->beta" copyLabel="Copy" copiedLabel="Copied" labels={labels} />)
  await waitFor(() => { expect(second.container.querySelector('[data-mermaid="ready"]')).not.toBeNull() })
  const firstSvg = first.container.querySelector('svg[id]')
  const secondSvg = second.container.querySelector('svg[id]')
  expect(firstSvg).not.toBeNull()
  expect(secondSvg?.id).not.toBe(firstSvg?.id)
  const ids = [...document.querySelectorAll('[data-mermaid="ready"] [id]')].map(node => node.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(firstSvg?.textContent).toContain('alpha')
  expect(secondSvg?.textContent).toContain('beta')
  const bodyBefore = [...document.body.children]
  const brokenCode = 'graph TD; alpha[unterminated'
  const broken = render(<MermaidDiagram code={brokenCode} copyLabel="Copy" copiedLabel="Copied" labels={labels} />)
  await waitFor(() => { expect(broken.container.querySelector('[data-mermaid="failed"]')).not.toBeNull() })
  expect(broken.container.textContent).toContain(brokenCode)
  expect(firstSvg?.isConnected).toBe(true)
  expect(secondSvg?.isConnected).toBe(true)
  expect([...document.body.children]).toEqual([...bodyBefore, broken.container])
  broken.unmount()
  first.unmount()
  expect(secondSvg?.isConnected).toBe(true)
  await act(async () => { document.documentElement.style.colorScheme = 'dark' })
  await waitFor(() => { expect(second.container.querySelector('svg[id]')?.id).toContain('-dark-') })
  expect(second.container.querySelector('svg[id]')?.textContent).toContain('alpha')
  expect([...document.body.children]).toEqual([...bodyBefore, broken.container])
}, 15_000)
