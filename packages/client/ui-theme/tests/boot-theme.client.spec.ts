// @vitest-environment jsdom
/** The theme bootstrap injection row and the resulting pre-plugin browser theme. */
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootThemeInjections, type BootFonts } from '../src/boot-theme.ts'
import type { FontSizes, ThemePreference } from '../src/theme-settings.ts'

const DARK_ATTRIBUTE = 'data-ds-dark-theme'

function mockSystemDark(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches }) as MediaQueryList))
}

function executeBootstrap(
  preference?: ThemePreference,
  fontSizes?: FontSizes,
  fonts?: BootFonts,
  uiFonts?: readonly string[],
): void {
  for (const row of bootThemeInjections(preference, fontSizes, undefined, fonts, uiFonts)) {
    if (row.kind === 'script') runInNewContext(row.text, { document, matchMedia: globalThis.matchMedia })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.dsThemeSource
  document.documentElement.style.removeProperty('--dsw-font-family')
  document.documentElement.style.removeProperty('--dsh-zoom-ui')
  document.documentElement.style.removeProperty('--dsh-zoom-chat')
  document.documentElement.style.removeProperty('--ds-font-family-code')
  document.documentElement.style.removeProperty('--dsw-font-size-code')
  document.documentElement.style.removeProperty('--dsh-font-size-term')
  document.body.removeAttribute(DARK_ATTRIBUTE)
  for (const name of ['--dsh-content-font-size', '--dsh-code-font-size', '--dsh-terminal-font-size']) document.body.style.removeProperty(name)
  for (const kind of ['text', 'code', 'terminal']) document.body.style.removeProperty(`--dsh-font-family-${kind}`)
})

describe('theme bootstrap row', () => {
  it('colors the body with head CSS before applying body state', () => {
    mockSystemDark(false)
    const [head, body] = bootThemeInjections('dark')
    expect(head).toMatchObject({ kind: 'style' })
    expect(body).toMatchObject({ kind: 'script', placement: 'body' })
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    if (body?.kind !== 'script') throw new Error('theme body bootstrap row is not a script')
    runInNewContext(body.text, { document, matchMedia: globalThis.matchMedia })
    expect(document.documentElement.dataset.dsThemeSource).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
  })

  it('lets durable light override a dark OS and clears stale dark state', () => {
    document.body.setAttribute(DARK_ATTRIBUTE, '')
    mockSystemDark(true)
    const [head] = bootThemeInjections('light')
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(':root{color-scheme:light}body{background-color:#fff;--dsh-boot-bg:#fff}')
    executeBootstrap('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it.each([
    [true, true],
    [false, false],
  ] as const)('resolves system=%s for the body palette', (matches, dark) => {
    mockSystemDark(matches)
    executeBootstrap('system')
    expect(document.documentElement.dataset.dsThemeSource).toBe('system')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(dark)
  })

  it('uses a media query for the system canvas palette', () => {
    const [head] = bootThemeInjections('system')
    if (head?.kind !== 'style') throw new Error('theme head bootstrap row is not a style')
    expect(head.text).toBe(
      ':root{color-scheme:light}body{background-color:#fff;--dsh-boot-bg:#fff}'
      + '@media(prefers-color-scheme:dark){:root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}}',
    )
  })

  it('defaults to system and falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    executeBootstrap()
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('writes the durable font sizes and their defaults', () => {
    mockSystemDark(false)
    executeBootstrap('light', { text: 22, code: 15, terminal: 18 })
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('22px')
    expect(document.body.style.getPropertyValue('--dsh-code-font-size')).toBe('15px')
    expect(document.body.style.getPropertyValue('--dsh-terminal-font-size')).toBe('18px')
    executeBootstrap('light')
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('14px')
    expect(document.body.style.getPropertyValue('--dsh-code-font-size')).toBe('11px')
    expect(document.body.style.getPropertyValue('--dsh-terminal-font-size')).toBe('13px')
  })

  it('writes normalized durable font lists and leaves empty lists unset', () => {
    mockSystemDark(false)
    const [, body] = bootThemeInjections('light', undefined, { text: 'Inter', code: '', terminal: 'MesloLGS NF</script>, monospace' })
    if (body?.kind !== 'script') throw new Error('theme body bootstrap row is not a script')
    expect(body.text).not.toContain('<')
    runInNewContext(body.text, { document, matchMedia: globalThis.matchMedia })
    expect(document.body.style.getPropertyValue('--dsh-font-family-text')).toBe('"Inter"')
    expect(document.body.style.getPropertyValue('--dsh-font-family-code')).toBe('')
    expect(document.body.style.getPropertyValue('--dsh-font-family-terminal')).toBe('"MesloLGS NF/script", monospace')
  })

  it('embeds the durable font selection as pre-paint CSS vars and the system family list', () => {
    mockSystemDark(false)
    executeBootstrap('dark', undefined, {
      uiFamily: 'Avenir Next', uiSize: 17, chatSize: 20,
      monoFont: 'menlo', monoSize: 18, termSize: 16,
    }, ['Avenir Next', 'Georgia'])
    expect(JSON.parse(document.documentElement.dataset.uiFonts ?? '[]')).toEqual(['Avenir Next', 'Georgia'])
    const style = document.documentElement.style
    expect(style.getPropertyValue('--dsw-font-family')).toContain("'Avenir Next'")
    // Sizes are px; the zoom vars are ratios against the section bases.
    expect(style.getPropertyValue('--dsh-zoom-ui')).toBe(String(17 / 14))
    expect(style.getPropertyValue('--dsh-zoom-chat')).toBe(String((20 / 16) / (17 / 14)))
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
})
