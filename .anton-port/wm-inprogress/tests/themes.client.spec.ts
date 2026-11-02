// Theme registry: unique ids and the macOS Aqua pair (registry data), plus
// the opencode-style completion — every LAYOUT_THEMES entry carries the full
// base-sheet token set derived from its own anchors, hand tokens stay
// authoritative, and the derivation is deterministic and readable (label/bg
// contrast floors). Node env — pure data math, no DOM.

import { describe, expect, it } from 'vitest'
import type { ThemeDefinition } from '@deepseek-ai/dsh-client-ui-theme/client'
import { COMPLETED_TOKENS, completeTheme } from '../src/client/theme-derive.ts'
import { LAYOUT_THEMES } from '../src/client/themes.ts'

const THEMES = LAYOUT_THEMES.filter(theme => theme.id !== 'anton-dark')

const HEX_PATTERN = /^#[0-9a-f]{3}([0-9a-f]{3}([0-9a-f]{2})?)?$/i
const RGBA_PATTERN = /^rgba\(\d+, \d+, \d+, (0|1|0?\.\d+)\)$/
const SHADOW_LAYER = '(0|[\\d.]+px)( (0|[\\d.]+px)){2} rgba\\(\\d+, \\d+, \\d+, [\\d.]+\\)'
const SHADOW_PATTERN = new RegExp(`^${SHADOW_LAYER}(, ${SHADOW_LAYER})*$`)

const matchesValue = (value: string): boolean =>
  HEX_PATTERN.test(value) || RGBA_PATTERN.test(value) || SHADOW_PATTERN.test(value)

/** WCAG relative luminance of a hex color. */
function luminance(hex: string): number {
  const digits = hex.slice(1)
  const channel = (index: number): number => {
    const raw = parseInt(digits.slice(index * 2, index * 2 + 2), 16) / 255
    return raw <= 0.04045 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

function contrast(a: string, b: string): number {
  const lighter = Math.max(luminance(a), luminance(b))
  const darker = Math.min(luminance(a), luminance(b))
  return (lighter + 0.05) / (darker + 0.05)
}

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

  it('defines the full base-sheet token set on every completed theme', () => {
    expect(THEMES.length).toBeGreaterThan(70)
    for (const theme of THEMES) {
      for (const token of COMPLETED_TOKENS) {
        expect(theme.tokens[token], `${theme.id} missing ${token}`).toSatisfy(matchesValue)
      }
    }
  })

  it('keeps anton-dark as the pure base palette', () => {
    const base = LAYOUT_THEMES.find(theme => theme.id === 'anton-dark')
    expect(base).toBeDefined()
    expect(base!.tokens).toEqual({})
  })

  it('is idempotent: completion never overwrites tokens it produced', () => {
    for (const theme of THEMES) {
      expect(completeTheme(theme)).toEqual(theme)
    }
  })

  it('derives the dark gruvbox surfaces and states from its warm anchors (golden)', () => {
    const gruvbox = THEMES.find(theme => theme.id === 'gruvbox')!
    expect(gruvbox.tokens).toMatchObject({
      '--dsw-specific-bubble': '#5c493e',
      '--dsw-alias-markdown-code-block': '#43413c',
      '--dsw-alias-border-l1': '#45403d',
      '--dsw-alias-state-warn-primary': '#ffbd00',
      '--dsw-alias-tooltip-bg': 'rgba(92, 88, 78, 0.95)',
      // Hand anchors survive derivation untouched.
      '--dsw-alias-bg-base': '#282828',
      '--dsw-alias-brand-primary': '#fabd2f',
    })
  })

  it('derives the light paper surfaces and states from its ink anchors (golden)', () => {
    const paper = THEMES.find(theme => theme.id === 'paper')!
    expect(paper.tokens).toMatchObject({
      '--dsw-specific-bubble': '#e3e3ca',
      '--dsw-alias-markdown-code-block': '#f0efeb',
      '--dsw-alias-state-success-primary': '#206905',
    })
  })

  it('keeps label text readable against the background on every theme', () => {
    for (const theme of THEMES) {
      const bg = theme.tokens['--dsw-alias-bg-base']!
      expect(contrast(theme.tokens['--dsw-alias-label-primary']!, bg), theme.id).toBeGreaterThanOrEqual(4.5)
      // 1.5, not 3: hand-port doom secondaries are deliberately dim faces
      // (bluloco-light sits at 1.6) and stay authoritative; the floor guards
      // against inverted or derivation-grayed labels, derived secondaries
      // land near 4.
      expect(contrast(theme.tokens['--dsw-alias-label-secondary']!, bg), theme.id).toBeGreaterThanOrEqual(1.5)
    }
  })

  it('derives three distinct state hues per theme', () => {
    for (const theme of THEMES) {
      const hues = [
        theme.tokens['--dsw-alias-state-error-primary']!,
        theme.tokens['--dsw-alias-state-warn-primary']!,
        theme.tokens['--dsw-alias-state-success-primary']!,
      ]
      expect(new Set(hues).size, theme.id).toBe(3)
    }
  })

  it('derives chat surfaces that differ from the base background', () => {
    for (const theme of THEMES) {
      expect(theme.tokens['--dsw-specific-bubble'], theme.id)
        .not.toBe(theme.tokens['--dsw-alias-bg-layer-1'])
      expect(theme.tokens['--dsw-alias-markdown-code-block'], theme.id)
        .not.toBe(theme.tokens['--dsw-alias-bg-base'])
    }
  })

  it('passes through definitions without anchors untouched', () => {
    const anchorless: ThemeDefinition = { id: 'probe-empty', colorScheme: 'dark', tokens: {} }
    expect(completeTheme(anchorless)).toBe(anchorless)
    const noBackground: ThemeDefinition = { id: 'probe-no-bg', colorScheme: 'light', tokens: { '--dsw-alias-label-primary': '#111111' } }
    expect(completeTheme(noBackground)).toBe(noBackground)
  })

  it('completes a minimal definition with short, long, and achromatic-only syntax faces', () => {
    const minimal: ThemeDefinition = {
      id: 'probe-minimal',
      colorScheme: 'dark',
      tokens: {
        '--dsw-alias-bg-base': '#04a',
        '--dsw-alias-label-primary': '#ffffff',
      },
      syntax: {
        '--shiki-token-keyword': '#ff000088',
        '--shiki-token-string': '#0f0',
        // Only achromatic faces: the red/amber/green seeds fall back neutral.
        '--shiki-token-comment': '#eeeeee',
      },
    }
    const completed = completeTheme(minimal)
    for (const token of COMPLETED_TOKENS) {
      expect(completed.tokens[token]).toSatisfy(matchesValue)
    }
    // Achromatic syntax faces must not seed the error hue.
    expect(completed.tokens['--dsw-alias-state-error-primary']).not.toBe('#ffffff')
    expect(completed.tokens['--dsw-alias-state-error-primary']).not.toBe('#eeeeee')
  })

  it('completes a light definition without a syntax palette or hand sidebar fill', () => {
    const bare: ThemeDefinition = {
      id: 'probe-bare',
      colorScheme: 'light',
      tokens: {
        '--dsw-alias-bg-base': '#e8e4da',
        '--dsw-alias-label-primary': '#2a2622',
      },
    }
    const completed = completeTheme(bare)
    expect(completed.syntax).toBeUndefined()
    for (const token of COMPLETED_TOKENS) {
      expect(completed.tokens[token]).toSatisfy(matchesValue)
    }
    // Mid-lightness light backgrounds take the ink-tinted code-block step.
    expect(completed.tokens['--dsw-alias-markdown-code-block']).not.toBe('#e8e4da')
  })
})
