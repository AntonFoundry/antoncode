// @vitest-environment jsdom
/**
 * Mermaid diagram spec: the copy-image control on a settled diagram — the
 * SVG rasterizes to a PNG blob and lands on the clipboard; where the
 * clipboard refuses, the same PNG downloads instead. The library is mocked
 * (the real mermaid needs layout the test DOM has not), so the render
 * pipeline returns a deterministic stub SVG.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MermaidDiagram, svgDimensions } from '@deepseek-ai/dsh-client-ui-primitives/src/markdown/mermaid.tsx'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80"/></svg>'

const renderMermaid = vi.hoisted(() => vi.fn(async () => ({ svg: SVG })))
const initialize = vi.hoisted(() => vi.fn())

vi.mock('mermaid', () => ({
  default: { initialize, render: renderMermaid },
}))

const labels = {
  rendering: 'Rendering…',
  failed: 'Failed',
  copyImage: 'Copy image',
  copied: 'Copied',
  copiedFailed: 'downloaded',
}

function pngBlob(): Blob {
  return new Blob(['png'], { type: 'image/png' })
}

describe('svgDimensions', () => {
  it('prefers the viewBox and applies the scale', () => {
    expect(svgDimensions(SVG, 2)).toEqual({ width: 240, height: 160 })
  })

  it('rejects an unsizeable document', () => {
    expect(svgDimensions('<html><body>nope</body></html>', 2)).toBeUndefined()
  })
})

describe('MermaidDiagram', () => {
  beforeEach(() => {
    renderMermaid.mockClear()
    initialize.mockClear()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the ready diagram with a copy-image control and writes the PNG to the clipboard', async () => {
    const write = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { write } })
    // jsdom has neither ClipboardItem nor a blob-url store.
    vi.stubGlobal('ClipboardItem', class {
      readonly types: string[]
      constructor(data: Record<string, Blob>) { this.types = Object.keys(data) }
    })
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })
    // jsdom has no canvas: the rasterizer's blob feeds the mocked clipboard
    // before any real draw is needed.
    // jsdom never loads resources: the rasterizer's Image resolves on assignment.
    vi.stubGlobal('Image', class {
      onload: () => void = () => {}
      onerror: () => void = () => {}
      set src(_value: string) { queueMicrotask(() => this.onload()) }
    })
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 0, height: 0,
          getContext: () => ({ scale: vi.fn(), drawImage: vi.fn() }),
          toBlob: (resolve: (b: Blob | null) => void) => resolve(pngBlob()),
        } as unknown as HTMLCanvasElement
      }
      return realCreate(tag)
    }) as typeof document.createElement)
    const { container } = render(
      <MermaidDiagram code="graph TD; a-->b" copyLabel="Copy" copiedLabel="Copied" labels={labels} />,
    )
    await waitFor(() => expect(container.querySelector('[data-mermaid="ready"]')).not.toBeNull())
    expect(initialize).toHaveBeenCalled()
    const button = screen.getByText('Copy image')
    fireEvent.click(button)
    await waitFor(() => expect(write).toHaveBeenCalled())
    const [items] = write.mock.calls[0] as [Array<{ types: string[] }>]
    expect(items[0]!.types).toContain('image/png')
  })

  it('downloads the PNG when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { write: vi.fn(async () => { throw new Error('denied') }) } })
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })
    // jsdom never loads resources: the rasterizer's Image resolves on assignment.
    vi.stubGlobal('Image', class {
      onload: () => void = () => {}
      onerror: () => void = () => {}
      set src(_value: string) { queueMicrotask(() => this.onload()) }
    })
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 0, height: 0,
          getContext: () => ({ scale: vi.fn(), drawImage: vi.fn() }),
          toBlob: (resolve: (b: Blob | null) => void) => resolve(pngBlob()),
        } as unknown as HTMLCanvasElement
      }
      return realCreate(tag)
    }) as typeof document.createElement)
    const { container } = render(
      <MermaidDiagram code="graph TD; a-->b" copyLabel="Copy" copiedLabel="Copied" labels={labels} />,
    )
    await waitFor(() => expect(container.querySelector('[data-mermaid="ready"]')).not.toBeNull())
    fireEvent.click(screen.getByText('Copy image'))
    await waitFor(() => expect(container.querySelector('[data-copy="copied"]')).toBeNull())
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it('falls back to the fenced source with the error when mermaid rejects', async () => {
    renderMermaid.mockRejectedValueOnce(new Error('bad diagram'))
    const { container } = render(
      <MermaidDiagram code="graph TD; broken" copyLabel="Copy" copiedLabel="Copied" labels={labels} />,
    )
    await waitFor(() => expect(container.querySelector('[data-mermaid="failed"]')).not.toBeNull())
    expect(container.textContent).toContain('bad diagram')
  })
})
