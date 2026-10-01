/**
 * Host-rendered theme bootstrap for the browser's pre-plugin interval. Each
 * index response embeds the current durable built-in preference and font
 * selection; the browser resolves only `system`, then writes the same DOM
 * fields ui-layout's ThemePresenter and ui-theme's FontRuntime own after the
 * client plugin tree activates.
 */

import {
  DEFAULT_MONO_FONT, DEFAULT_MONO_SIZE, DEFAULT_PREFERENCE, DEFAULT_SCALE,
  DEFAULT_TERM_SIZE, DEFAULT_UI_FAMILY, monoFontStack, uiFontStack,
  type ThemePreference,
} from './theme-settings.ts'

/** Durable font selection embedded in the bootstrap (mirrors FontSelection). */
export interface BootFonts {
  /** Curated UI family id. */
  uiFamily: string
  /** Interface zoom percent. */
  uiScale: number
  /** Chat pane zoom percent. */
  chatScale: number
  /** Curated monospace family id. */
  monoFont: string
  /** Monospace size in px. */
  monoSize: number
  /** Terminal size in px. */
  termSize: number
}

/** Build the inline script for one schema-validated built-in preference. */
function bootThemeScript(preference: ThemePreference, fonts: BootFonts): string {
  const chatZoom = fonts.chatScale / fonts.uiScale
  return `<script>(() => {
  const preference = ${JSON.stringify(preference)}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  const root = document.documentElement.style
  root.setProperty('--dsw-font-family', ${JSON.stringify(uiFontStack(fonts.uiFamily))})
  root.setProperty('--dsh-zoom-ui', ${JSON.stringify(String(fonts.uiScale / 100))})
  root.setProperty('--dsh-zoom-chat', ${JSON.stringify(String(chatZoom))})
  root.setProperty('--ds-font-family-code', ${JSON.stringify(monoFontStack(fonts.monoFont))})
  root.setProperty('--dsw-font-size-code', ${JSON.stringify(`${fonts.monoSize}px`)})
  root.setProperty('--dsh-font-size-term', ${JSON.stringify(`${fonts.termSize}px`)})
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
    uiFamily: DEFAULT_UI_FAMILY, uiScale: DEFAULT_SCALE, chatScale: DEFAULT_SCALE,
    monoFont: DEFAULT_MONO_FONT, monoSize: DEFAULT_MONO_SIZE, termSize: DEFAULT_TERM_SIZE,
  },
): string {
  const script = bootThemeScript(preference, fonts)
  const body = /<body(?:\s[^>]*)?>/i.exec(html)
  if (body === null) return `${html}${script}`
  const at = body.index + body[0].length
  return `${html.slice(0, at)}${script}${html.slice(at)}`
}
