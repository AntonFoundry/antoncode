// @vitest-environment jsdom
/** ImageFileView: media URL wiring, load/error states, retry, and the OS-open escape hatch. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ImageFileView } from '../src/client/ImageFileView.tsx'
import type { ImageFileViewProps } from '../src/client/ImageFileView.tsx'

/** Owner-share stub with a deterministic media URL and inert faces. */
function props(over: Partial<ImageFileViewProps> = {}): ImageFileViewProps {
  return {
    path: '/w/shot.png',
    readText: () => Promise.resolve({ content: '', truncated: false }),
    mediaUrl: p => `/api/host/media?path=${encodeURIComponent(p)}`,
    openWithOs: vi.fn(),
    ...over,
  } as ImageFileViewProps
}

afterEach(() => { cleanup() })

describe('ImageFileView', () => {
  it('renders the img from the media endpoint URL and reports ready on load', () => {
    const { container } = render(<ImageFileView {...props()} />)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/api/host/media?path=%2Fw%2Fshot.png')
    expect(img?.getAttribute('alt')).toBe('/w/shot.png')
    expect(img?.getAttribute('data-status')).toBe('loading')
    fireEvent.load(img!)
    expect(img?.getAttribute('data-status')).toBe('ready')
    expect(container.querySelector('[data-testid="image-file-view-failed"]')).toBeNull()
  })

  it('a load failure shows the note with retry and the OS-open escape hatch', () => {
    const openWithOs = vi.fn()
    const { container } = render(<ImageFileView {...props({ openWithOs })} />)
    fireEvent.error(container.querySelector('img')!)
    expect(screen.getByText('/w/shot.png — could not load this image')).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
    fireEvent.click(screen.getByText('Open with default app'))
    expect(openWithOs).toHaveBeenCalledWith('/w/shot.png')
    // The failed img hides; retry re-mounts it for a fresh request.
    expect(container.querySelector('img')?.getAttribute('data-status')).toBe('failed')
    fireEvent.click(screen.getByText('Retry'))
    expect(container.querySelector('img')?.getAttribute('data-status')).toBe('loading')
  })
})
