/** Pure file-view dispatch: extension→viewer-key routing, the opener's inline set, and the text fallback's grammar hints. */
import { describe, expect, it } from 'vitest'
import { opensInline, viewerKeyFor, viewerLanguageFor } from '../src/client/file-view.ts'

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

  it('directory-ish paths hand off to the Host open instead of claiming an inline buffer', () => {
    expect(opensInline('.')).toBe(false)
    expect(opensInline('..')).toBe(false)
    expect(opensInline('/w/src/')).toBe(false)
    expect(opensInline('/w/dir/.')).toBe(false)
    expect(opensInline('/w/dir/..')).toBe(false)
    expect(opensInline('src')).toBe(true)
    expect(opensInline('/w/Makefile')).toBe(true)
    expect(opensInline('/w/no-extension')).toBe(true)
    expect(opensInline('/w/.gitignore')).toBe(true)
  })
})

describe('viewerLanguageFor', () => {
  it('maps code extensions to the shared highlighter grammar ids, case-insensitively', () => {
    expect(viewerLanguageFor('/w/main.ts')).toBe('ts')
    expect(viewerLanguageFor('/w/App.TSX')).toBe('tsx')
    expect(viewerLanguageFor('/w/server.mjs')).toBe('js')
    expect(viewerLanguageFor('/w/app.py')).toBe('py')
    expect(viewerLanguageFor('/w/lib.rs')).toBe('rs')
    expect(viewerLanguageFor('/w/style.scss')).toBe('scss')
    expect(viewerLanguageFor('/w/compose.yml')).toBe('yaml')
    // One sample per added grammar family: the map covers every id ui-primitives'
    // alias table resolves, so these pin the extension→alias wiring.
    expect(viewerLanguageFor('/w/build.dockerfile')).toBe('dockerfile')
    expect(viewerLanguageFor('/w/Main.scala')).toBe('scala')
    expect(viewerLanguageFor('/w/app.ex')).toBe('ex')
    expect(viewerLanguageFor('/w/service.ps1')).toBe('ps1')
    expect(viewerLanguageFor('/w/schema.proto')).toBe('proto')
    expect(viewerLanguageFor('/w/infra/main.tf')).toBe('tf')
    expect(viewerLanguageFor('/w/App.vue')).toBe('vue')
    expect(viewerLanguageFor('/w/paper.tex')).toBe('tex')
    expect(viewerLanguageFor('/w/view.m')).toBe('objc')
    expect(viewerLanguageFor('/w/core.janet')).toBe('janet')
    expect(viewerLanguageFor('/w/actors.ben')).toBe('bender')
    expect(viewerLanguageFor('/w/init.el')).toBe('elisp')
    expect(viewerLanguageFor('/w/app.hy')).toBe('hy')
    expect(viewerLanguageFor('/w/main.purs')).toBe('purescript')
    expect(viewerLanguageFor('/w/notes.unknownext')).toBeUndefined()
  })

  it('a dotfile and an extensionless path take the plain-text path', () => {
    expect(viewerLanguageFor('/w/.gitignore')).toBeUndefined()
    expect(viewerLanguageFor('/w/Makefile')).toBeUndefined()
    expect(viewerLanguageFor('/w/no-extension')).toBeUndefined()
  })

  it('an Object.prototype-keyed extension misses instead of resolving an inherited member', () => {
    expect(viewerLanguageFor('/w/foo.constructor')).toBeUndefined()
    expect(viewerLanguageFor('/w/foo.__proto__')).toBeUndefined()
    expect(viewerLanguageFor('/w/foo.toString')).toBeUndefined()
  })
})
