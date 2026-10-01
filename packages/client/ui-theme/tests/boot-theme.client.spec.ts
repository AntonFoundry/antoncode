// @vitest-environment jsdom
/** Host index injection and the resulting pre-plugin browser theme. */
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { injectBootTheme, type BootFonts } from '../src/boot-theme.ts'
import type { ThemePreference } from '../src/theme-settings.ts'

const DARK_ATTRIBUTE = 'data-ds-dark-theme'

function mockSystemDark(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches }) as MediaQueryList))
}

function executeBootstrap(
  preference?: ThemePreference,
  html = '<html><body><div id="root"></div><script type="module"></script></body></html>',
  fonts?: BootFonts,
): string {
  const injected = injectBootTheme(html, preference, fonts)
  const source = /<script>([\s\S]*?)<\/script>/.exec(injected)?.[1]
  if (source === undefined) throw new Error('theme bootstrap script missing')
  runInNewContext(source, { document, matchMedia: globalThis.matchMedia })
  return injected
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.style.removeProperty('color-scheme')
  document.documentElement.style.removeProperty('--dsw-font-family')
  document.documentElement.style.removeProperty('--dsh-zoom-ui')
  document.documentElement.style.removeProperty('--dsh-zoom-chat')
  document.documentElement.style.removeProperty('--ds-font-family-code')
  document.documentElement.style.removeProperty('--dsw-font-size-code')
  document.documentElement.style.removeProperty('--dsh-font-size-term')
  document.body.removeAttribute(DARK_ATTRIBUTE)
})

describe('theme boot index transform', () => {
  it('runs immediately inside the body before the shell mount', () => {
    mockSystemDark(false)
    const html = executeBootstrap('dark', '<html><body class="app"><div id="root"></div></body></html>')
    expect(html.indexOf('<script>')).toBeGreaterThan(html.indexOf('<body class="app">'))
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<div id="root">'))
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
  })

  it('lets durable light override a dark OS and clears stale dark state', () => {
    document.body.setAttribute(DARK_ATTRIBUTE, '')
    mockSystemDark(true)
    executeBootstrap('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it.each([
    [true, 'dark', true],
    [false, 'light', false],
  ] as const)('resolves system=%s to %s', (matches, colorScheme, dark) => {
    mockSystemDark(matches)
    executeBootstrap('system')
    expect(document.documentElement.style.colorScheme).toBe(colorScheme)
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(dark)
  })

  it('defaults to system and falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    executeBootstrap()
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('embeds the durable font selection as pre-paint CSS vars', () => {
    mockSystemDark(false)
    executeBootstrap('dark', undefined, {
      uiFamily: 'georgia', uiScale: 120, chatScale: 90,
      monoFont: 'menlo', monoSize: 18, termSize: 16,
    })
    const style = document.documentElement.style
    expect(style.getPropertyValue('--dsw-font-family')).toContain('Georgia')
    expect(style.getPropertyValue('--dsh-zoom-ui')).toBe('1.2')
    expect(style.getPropertyValue('--dsh-zoom-chat')).toBe('0.75')
    expect(style.getPropertyValue('--ds-font-family-code')).toContain('Menlo')
    expect(style.getPropertyValue('--dsw-font-size-code')).toBe('18px')
    expect(style.getPropertyValue('--dsh-font-size-term')).toBe('16px')
  })

  it('defaults to the shipped selection when no font selection was persisted', () => {
    mockSystemDark(false)
    executeBootstrap()
    const style = document.documentElement.style
    expect(style.getPropertyValue('--dsw-font-family')).toContain('-apple-system')
    expect(style.getPropertyValue('--dsh-zoom-ui')).toBe('1')
    expect(style.getPropertyValue('--dsh-zoom-chat')).toBe('1')
    expect(style.getPropertyValue('--ds-font-family-code')).toContain('Monaco')
    expect(style.getPropertyValue('--dsw-font-size-code')).toBe('15px')
    expect(style.getPropertyValue('--dsh-font-size-term')).toBe('13px')
  })

  it('appends the script to a body-less fragment', () => {
    const html = injectBootTheme('<main>loading</main>', 'dark')
    expect(html.startsWith('<main>loading</main><script>')).toBe(true)
  })
})
