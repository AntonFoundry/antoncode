// Registry data account for the compos-style palette: unique ids, the macOS
// Aqua pair present with its scheme semantics, and token maps that only
// override --dsw-* custom properties (the presenter writes them as inline
// variables on body, so a non-custom-property name would never apply).

import { describe, expect, it } from 'vitest'
import { LAYOUT_THEMES } from '@deepseek-ai/dsh-client-ui-layout/src/client/themes.ts'

describe('LAYOUT_THEMES', () => {
  it('registers unique ids including the macOS Aqua pair', () => {
    const ids = LAYOUT_THEMES.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('macos')
    expect(ids).toContain('macos-dark')
    expect(LAYOUT_THEMES.find(t => t.id === 'macos')?.colorScheme).toBe('light')
    expect(LAYOUT_THEMES.find(t => t.id === 'macos-dark')?.colorScheme).toBe('dark')
  })

  it('keeps every palette a --dsw-* override layer with the Aqua signature accents', () => {
    for (const theme of LAYOUT_THEMES) {
      for (const name of Object.keys(theme.tokens)) {
        expect(name.startsWith('--dsw-'), `${theme.id}: ${name}`).toBe(true)
      }
    }
    expect(LAYOUT_THEMES.find(t => t.id === 'macos')?.tokens['--dsw-alias-brand-primary']).toBe('#007aff')
    expect(LAYOUT_THEMES.find(t => t.id === 'macos-dark')?.tokens['--dsw-alias-brand-primary']).toBe('#0a84ff')
  })
})
