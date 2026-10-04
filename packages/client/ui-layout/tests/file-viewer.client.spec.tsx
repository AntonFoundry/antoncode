// @vitest-environment jsdom
/**
 * FileViewer: the text fallback renders through the shared CodeBlock shiki path
 * when the extension resolves a grammar, plain otherwise; fetch failure and
 * truncation notes stay.
 */
import { render, cleanup } from '@testing-library/react'
import { afterEach, expect, it, describe } from 'vitest'
import { FileViewer } from '../src/client/FileViewer.tsx'
import type { FileViewerProps } from '../src/client/FileViewer.tsx'

afterEach(cleanup)

function props(over: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    path: '/w/main.ts',
    readText: () => Promise.resolve({ content: 'const x = 1\n', truncated: false }),
    ...over,
  }
}

describe('FileViewer', () => {
  it('a code extension renders the highlighted shiki tree', async () => {
    const view = render(<FileViewer {...props()} />)
    const body = await view.findByTestId('file-viewer')
    expect(body.querySelector('pre.shiki')).not.toBeNull()
    expect(body.textContent).toContain('const x = 1')
  })

  it('an unknown extension renders the identical-geometry plain fallback', async () => {
    const view = render(<FileViewer {...props({ path: '/w/blob.unknownext' })} />)
    const body = await view.findByTestId('file-viewer')
    expect(body.querySelector('pre.shiki')).toBeNull()
    expect(body.querySelector('pre')).not.toBeNull()
  })

  it('a read failure renders the message instead of the body', async () => {
    const view = render(<FileViewer {...props({ readText: () => Promise.reject(new Error('browse down')) })} />)
    const body = await view.findByTestId('file-viewer')
    expect(body.textContent).toContain('browse down')
    expect(body.querySelector('pre')).toBeNull()
  })

  it('a truncated read keeps the 512 KiB note over the body', async () => {
    const view = render(<FileViewer {...props({ readText: () => Promise.resolve({ content: 'x', truncated: true }) })} />)
    const body = await view.findByTestId('file-viewer')
    expect(body.textContent).toContain('showing the first 512 KiB')
    expect(body.getAttribute('data-truncated')).toBe('true')
  })
})
