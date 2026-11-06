// @vitest-environment jsdom
/** MarkdownFileView: engine rendering, loading/failure notes, and the truncation flag. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MarkdownFileView } from '../src/client/MarkdownFileView.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import type { MarkdownFileViewProps } from '../src/client/MarkdownFileView.tsx'

/** Owner-share stub: a resolving read face over a small fixture unless overridden. */
function props(over: Partial<MarkdownFileViewProps> = {}): MarkdownFileViewProps {
  return {
    t: makeTranslate(en),
    path: '/w/README.md',
    readText: () => Promise.resolve({ content: '# Title\n\nBody text.', truncated: false }),
    mediaUrl: p => `/api/host/media?path=${encodeURIComponent(p)}`,
    openWithOs: () => {},
    ...over,
  }
}

afterEach(() => { cleanup() })

describe('MarkdownFileView', () => {
  it('renders the fetched file through the shared markdown engine', async () => {
    const { container } = render(<MarkdownFileView {...props()} />)
    // The loading note is the first paint; the engine's output replaces it.
    expect(screen.getByText('/w/README.md — loading…')).toBeTruthy()
    await waitFor(() => { expect(container.querySelector('h1')?.textContent).toBe('Title') })
    expect(screen.getByText('Body text.')).toBeTruthy()
    expect(container.querySelector('[data-testid="markdown-file-view"]')).toBeTruthy()
  })

  it('renders a rejected read as the error note instead of a body', async () => {
    const { container } = render(<MarkdownFileView {...props({ readText: () => Promise.reject(new Error('browse down')) })} />)
    await waitFor(() => { expect(container.textContent).toContain('/w/README.md: browse down') })
    expect(container.querySelector('h1')).toBeNull()
  })

  it('renders an unavailable read face as the failure note', async () => {
    const { container } = render(<MarkdownFileView {...props({ readText: () => Promise.resolve(undefined) })} />)
    await waitFor(() => { expect(container.textContent).toContain('/w/README.md: read unavailable') })
  })

  it('flags a head-truncated read', async () => {
    const { container } = render(<MarkdownFileView {...props({ readText: () => Promise.resolve({ content: '# Head', truncated: true }) })} />)
    await waitFor(() => { expect(screen.getByText('Showing the first 512 KiB')).toBeTruthy() })
    expect(container.querySelector('[data-truncated]')).toBeTruthy()
  })
})
