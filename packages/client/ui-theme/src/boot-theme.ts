/**
 * Theme bootstrap row for the browser's pre-plugin interval. Each index
 * render embeds the current durable built-in preference, the role font sizes
 * and font-family lists, and the sectioned font selection. Head CSS colors the
 * document canvas before script execution; the body script installs the
 * palette selector and the font variables that ui-layout's ThemePresenter and
 * ui-theme's FontRuntime own after the client plugin tree activates.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  CHAT_ZOOM_BASE, DEFAULT_CHAT_SIZE, DEFAULT_FONT_SIZES, DEFAULT_MONO_FONT, DEFAULT_MONO_SIZE,
  DEFAULT_PREFERENCE, DEFAULT_TERM_SIZE, DEFAULT_UI_FAMILY, DEFAULT_UI_SIZE, FONT_ROLES, FONT_SIZE_SPECS,
  fontFamilyVariable, monoFontStack, normalizeFontFamily, UI_ZOOM_BASE, uiFamilyStack,
  type FontFamilies, type FontSizes, type ThemePreference,
} from './theme-settings.ts'

/** Durable sectioned font selection embedded in the bootstrap (mirrors FontSelection). */
export interface BootFonts {
  /** UI family name, or 'system'. */
  uiFamily: string
  /** Interface base text size in px. */
  uiSize: number
  /** Chat-pane base text size in px. */
  chatSize: number
  /** Curated monospace family id. */
  monoFont: string
  /** Monospace size in px. */
  monoSize: number
  /** Terminal size in px. */
  termSize: number
}

/** Sectioned font selection when the user-settings document has no override. */
export const DEFAULT_BOOT_FONTS: BootFonts = Object.freeze({
  uiFamily: DEFAULT_UI_FAMILY, uiSize: DEFAULT_UI_SIZE, chatSize: DEFAULT_CHAT_SIZE,
  monoFont: DEFAULT_MONO_FONT, monoSize: DEFAULT_MONO_SIZE, termSize: DEFAULT_TERM_SIZE,
})

const LIGHT_BACKGROUND = '#fff'
const DARK_BACKGROUND = '#151517'

/** CSS that colors the document canvas before any script executes. */
function bootThemeStyle(preference: ThemePreference): string {
  const light = `:root{color-scheme:light}body{background-color:${LIGHT_BACKGROUND};--dsh-boot-bg:${LIGHT_BACKGROUND}}`
  const dark = `:root{color-scheme:dark}body{background-color:${DARK_BACKGROUND};--dsh-boot-bg:${DARK_BACKGROUND}}`
  if (preference === 'light') return light
  if (preference === 'dark') return dark
  return `${light}@media(prefers-color-scheme:dark){${dark}}`
}

/**
 * Encode one string as a JS literal safe inside an inline script: `<` is
 * escaped so a family name cannot close the script element.
 */
function scriptLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** Build the body script that installs the palette selector and font variables. */
function bootThemeBodyScript(
  preference: ThemePreference, fontSizes: FontSizes, fontFamilies: FontFamilies,
  fonts: BootFonts, uiFonts: readonly string[],
): string {
  const sizes = FONT_ROLES.map(role =>
    `\n  document.body.style.setProperty(${JSON.stringify(FONT_SIZE_SPECS[role].variable)}, ${JSON.stringify(`${fontSizes[role]}px`)})`).join('')
  const families = FONT_ROLES.flatMap((kind) => {
    const list = normalizeFontFamily(fontFamilies[kind])
    return list === '' ? [] : [`\n  document.body.style.setProperty(${JSON.stringify(fontFamilyVariable(kind))}, ${JSON.stringify(list)})`]
  }).join('')
  // Zoom is an implementation detail: each section's px size is expressed
  // as a ratio against the section's shipped base.
  const uiZoom = fonts.uiSize / UI_ZOOM_BASE
  const chatZoom = fonts.chatSize / CHAT_ZOOM_BASE / uiZoom
  return `(() => {
  const preference = ${JSON.stringify(preference)}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.dataset.dsThemeSource = preference
  document.body.toggleAttribute('data-ds-dark-theme', dark)${sizes}${families}
  const root = document.documentElement.style
  root.setProperty('--dsw-font-family', ${scriptLiteral(uiFamilyStack(fonts.uiFamily))})
  root.setProperty('--dsh-zoom-ui', ${JSON.stringify(String(uiZoom))})
  root.setProperty('--dsh-zoom-chat', ${JSON.stringify(String(chatZoom))})
  root.setProperty('--ds-font-family-code', ${JSON.stringify(monoFontStack(fonts.monoFont))})
  root.setProperty('--dsw-font-size-code', ${JSON.stringify(`${fonts.monoSize}px`)})
  root.setProperty('--dsh-font-size-term', ${JSON.stringify(`${fonts.termSize}px`)})
  document.documentElement.dataset.uiFonts = ${scriptLiteral(JSON.stringify(uiFonts))}
})()`
}

/**
 * Theme bootstrap rows: head CSS colors the document canvas before
 * first paint, then the body script installs the palette selector, the role
 * font sizes and font families, and the sectioned font variables before the
 * shell mount and module script.
 * @param preference - Current Host-backed built-in preference.
 * @param fontSizes - Current Host-backed font sizes in px by role.
 * @param fontFamilies - Current Host-backed font lists; each is normalized before embedding.
 * @param fonts - Current Host-backed sectioned font selection.
 * @param uiFonts - Installed system font families embedded for the Font row's family menu.
 * @returns head and body script rows in execution order.
 */
export function bootThemeInjections(
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fontSizes: FontSizes = DEFAULT_FONT_SIZES,
  fontFamilies: FontFamilies = { text: '', code: '', terminal: '' },
  fonts: BootFonts = DEFAULT_BOOT_FONTS,
  uiFonts: readonly string[] = [],
): IndexInjection[] {
  return [
    { kind: 'style', text: bootThemeStyle(preference) },
    { kind: 'script', placement: 'body', text: bootThemeBodyScript(preference, fontSizes, fontFamilies, fonts, uiFonts) },
  ]
}
