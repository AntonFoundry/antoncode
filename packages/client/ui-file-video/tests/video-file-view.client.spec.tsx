// @vitest-environment jsdom
/** VideoFileView: native src, the one-shot remux fallback, the silent-audio manual rescue, and the failure note with retry + OS-open. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VideoFileView } from '../src/client/VideoFileView.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import type { VideoFileViewProps } from '../src/client/VideoFileView.tsx'

/** Owner-share stub with a deterministic media URL and inert faces. */
function props(over: Partial<VideoFileViewProps> = {}): VideoFileViewProps {
  return {
    t: makeTranslate(en),
    path: '/w/clip.mkv',
    readText: () => Promise.resolve({ content: '', truncated: false }),
    mediaUrl: p => `/api/host/media?path=${encodeURIComponent(p)}`,
    openWithOs: vi.fn(),
    ...over,
  }
}

afterEach(() => { cleanup() })

describe('VideoFileView', () => {
  it('renders the native endpoint URL first', () => {
    const { container } = render(<VideoFileView {...props()} />)
    const video = container.querySelector('video')
    expect(video?.getAttribute('src')).toBe('/api/host/media?path=%2Fw%2Fclip.mkv')
    expect(video?.hasAttribute('controls')).toBe(true)
    expect(container.querySelector('[data-stage="native"]')).toBeTruthy()
  })

  it('one playback error flips the source to the remux stream, a second gives up', () => {
    const { container } = render(<VideoFileView {...props()} />)
    fireEvent.error(container.querySelector('video')!)
    expect(container.querySelector('[data-stage="remux"]')).toBeTruthy()
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/api/host/media?path=%2Fw%2Fclip.mkv&remux=1')
    fireEvent.error(container.querySelector('video')!)
    expect(container.querySelector('video')).toBeNull()
    expect(screen.getByText('/w/clip.mkv — this video cannot be played inline')).toBeTruthy()
  })

  it('the failure note offers retry (back to native) and the OS-open escape hatch', () => {
    const openWithOs = vi.fn()
    const { container } = render(<VideoFileView {...props({ openWithOs })} />)
    fireEvent.error(container.querySelector('video')!)
    fireEvent.error(container.querySelector('video')!)
    fireEvent.click(screen.getByText('Open with default app'))
    expect(openWithOs).toHaveBeenCalledWith('/w/clip.mkv')
    fireEvent.click(screen.getByText('Retry'))
    expect(container.querySelector('[data-stage="native"]')).toBeTruthy()
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/api/host/media?path=%2Fw%2Fclip.mkv')
  })

  it('silent playback (no error event) is rescuable through the manual remux hint', () => {
    const { container } = render(<VideoFileView {...props()} />)
    // Native stage shows the hint; a silently-playing stream fires no error,
    // so the user flips to the remux (audio→AAC) stream themselves.
    expect(screen.getByText('Play via remux')).toBeTruthy()
    fireEvent.click(screen.getByText('Play via remux'))
    expect(container.querySelector('[data-stage="remux"]')).toBeTruthy()
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/api/host/media?path=%2Fw%2Fclip.mkv&remux=1')
    expect(screen.queryByText('Play via remux')).toBeNull()
  })
})
