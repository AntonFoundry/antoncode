/**
 * Host-rendered theme bootstrap for the browser's pre-plugin interval. Each
 * index response embeds the current durable built-in preference and font
 * selection; the browser resolves only `system`, then writes the same DOM
 * fields ui-layout's ThemePresenter and ui-theme's FontRuntime own after the
 * client plugin tree activates.
 */

import {
  CHAT_ZOOM_BASE, DEFAULT_CHAT_SIZE, DEFAULT_MONO_FONT, DEFAULT_MONO_SIZE,
  DEFAULT_PREFERENCE, DEFAULT_TERM_SIZE, DEFAULT_UI_FAMILY, DEFAULT_UI_SIZE,
  monoFontStack, UI_ZOOM_BASE, uiFamilyStack,
  type ThemePreference,
} from './theme-settings.ts'

/** Durable font selection embedded in the bootstrap (mirrors FontSelection). */
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

/** Build the inline script for one schema-validated built-in preference. */
function bootThemeScript(preference: ThemePreference, fonts: BootFonts, uiFonts: readonly string[]): string {
  // Zoom is an implementation detail: each section's px size is expressed
  // as a ratio against the section's shipped base.
  const uiZoom = fonts.uiSize / UI_ZOOM_BASE
  const chatZoom = fonts.chatSize / CHAT_ZOOM_BASE / uiZoom
  return `<script>(() => {
  const preference = ${JSON.stringify(preference)}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  const root = document.documentElement.style
  root.setProperty('--dsw-font-family', ${JSON.stringify(uiFamilyStack(fonts.uiFamily))})
  root.setProperty('--dsh-zoom-ui', ${JSON.stringify(String(uiZoom))})
  root.setProperty('--dsh-zoom-chat', ${JSON.stringify(String(chatZoom))})
  root.setProperty('--ds-font-family-code', ${JSON.stringify(monoFontStack(fonts.monoFont))})
  root.setProperty('--dsw-font-size-code', ${JSON.stringify(`${fonts.monoSize}px`)})
  root.setProperty('--dsh-font-size-term', ${JSON.stringify(`${fonts.termSize}px`)})
  document.documentElement.dataset.uiFonts = ${JSON.stringify(JSON.stringify(uiFonts))}
})()</script>`
}

/**
 * Insert the theme bootstrap immediately after the opening body tag, before
 * the shell mount and module script. Body-less fragments receive it at the
 * end, where the HTML parser has already synthesized a body.
 * @param html - Raw application index HTML.
 * @param preference - Current Host-backed built-in preference.
 * @param fonts - Current Host-backed font selection.
 * @returns HTML containing the theme bootstrap.
 */
export function injectBootTheme(
  html: string,
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fonts: BootFonts = {
    uiFamily: DEFAULT_UI_FAMILY, uiSize: DEFAULT_UI_SIZE, chatSize: DEFAULT_CHAT_SIZE,
    monoFont: DEFAULT_MONO_FONT, monoSize: DEFAULT_MONO_SIZE, termSize: DEFAULT_TERM_SIZE,
  },
  uiFonts: readonly string[] = [],
): string {
  const script = bootThemeScript(preference, fonts, uiFonts)
  const body = /<body(?:\s[^>]*)?>/i.exec(html)
  if (body === null) return `${html}${script}`
  const at = body.index + body[0].length
  return `${html.slice(0, at)}${script}${html.slice(at)}`
}
