/** Pure file-view dispatch: extension→viewer-key routing and the opener's inline set. */
import { describe, expect, it } from 'vitest'
import { opensInline, viewerKeyFor } from '../src/client/file-view.ts'

describe('viewerKeyFor', () => {
  it('routes the shipped viewer families by extension, case-insensitively', () => {
    expect(viewerKeyFor('/w/README.md')).toBe('markdown')
    expect(viewerKeyFor('/w/notes.MARKDOWN')).toBe('markdown')
    expect(viewerKeyFor('/w/photo.PNG')).toBe('image')
    expect(viewerKeyFor('/w/photo.jpeg')).toBe('image')
    expect(viewerKeyFor('/w/icon.svg')).toBe('image')
    expect(viewerKeyFor('/w/clip.mp4')).toBe('video')
    expect(viewerKeyFor('/w/clip.MKV')).toBe('video')
  })

  it('maps text families and unknown extensions to the text fallback', () => {
    expect(viewerKeyFor('/w/main.ts')).toBe('text')
    expect(viewerKeyFor('/w/archive.zip')).toBe('text')
    expect(viewerKeyFor('/w/Makefile')).toBe('text')
    expect(viewerKeyFor('/w/no-extension')).toBe('text')
  })
})

describe('opensInline', () => {
  it('opens viewer families and unknown text inline, binary hand-offs to the OS', () => {
    expect(opensInline('/w/README.md')).toBe(true)
    expect(opensInline('/w/photo.png')).toBe(true)
    expect(opensInline('/w/clip.mov')).toBe(true)
    expect(opensInline('/w/main.rs')).toBe(true)
    expect(opensInline('/w/unknown.xyz')).toBe(true)
    expect(opensInline('/w/report.pdf')).toBe(false)
    expect(opensInline('/w/backup.tiff')).toBe(false)
    expect(opensInline('/w/clip.mp3')).toBe(false)
  })
})
