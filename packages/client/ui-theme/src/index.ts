/** Host registration for the browser theme preference and pre-plugin palette. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'
import type { ThemePreference } from './theme-settings.ts'
import z from '@deepseek-ai/schemastery'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { bootThemeInjections } from './boot-theme.ts'
import {
  CHAT_SIZE_RANGE, DEFAULT_CHAT_SIZE, DEFAULT_MONO_FONT, DEFAULT_MONO_SIZE, DEFAULT_PREFERENCE,
  DEFAULT_TERM_SIZE, DEFAULT_UI_FAMILY, DEFAULT_UI_SIZE, FONT_SIZE_SPECS, fontSizeSchema,
  MONO_SIZE_RANGE, TERM_SIZE_RANGE, THEME_PREFERENCES, UI_SIZE_RANGE,
} from './theme-settings.ts'
import { listSystemFontFamilies } from './system-fonts.ts'

export {
  CHAT_SIZE_FIELD, CHAT_SIZE_RANGE, CHAT_ZOOM_BASE, DEFAULT_CHAT_SIZE, DEFAULT_FONT_SIZE,
  DEFAULT_MONO_FONT, DEFAULT_MONO_SIZE, DEFAULT_PREFERENCE, DEFAULT_TERM_SIZE,
  DEFAULT_UI_FAMILY, DEFAULT_UI_SIZE, FONT_SIZE_FIELD, FONT_SIZE_MAX, FONT_SIZE_MIN,
  MONO_FONTS, MONO_FONT_FIELD, MONO_SIZE_FIELD, MONO_SIZE_RANGE, TERM_SIZE_FIELD, TERM_SIZE_RANGE,
  THEME_PREFERENCE_FIELD, THEME_PREFERENCES, THEME_SETTINGS_NAMESPACE, UI_FONTS, UI_FONT_FIELD,
  UI_SIZE_FIELD, UI_SIZE_RANGE, UI_ZOOM_BASE, isMonoFont, monoFontStack, uiFamilyStack,
  type MonoFontOption, type ThemePreference, type ThemeSettings, type UiFontOption,
} from './theme-settings.ts'
export { listSystemFontFamilies, parseFontFileFamilies } from './system-fonts.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Browser palette preference. */
  preference: Volatile<ThemePreference>
  /** Browser font size in pixels. */
  fontSize: Volatile<number>
  /** Code-block font size in pixels. */
  codeFontSize: Volatile<number>
  /** Sidebar terminal font size in pixels. */
  terminalFontSize: Volatile<number>
  /** Interface and body text font list; `''` keeps the built-in stack. */
  textFontFamily: Volatile<string>
  /** Code font list; `''` keeps the built-in stack. */
  codeFontFamily: Volatile<string>
  /** Sidebar terminal font list; `''` keeps the built-in stack. */
  terminalFontFamily: Volatile<string>
  /** Font row interface family name, or 'system'. */
  uiFamily: Volatile<string>
  /** Font row interface base text size in px. */
  uiSize: Volatile<number>
  /** Font row chat-pane base text size in px. */
  chatSize: Volatile<number>
  /** Font row curated monospace family id. */
  monoFont: Volatile<string>
  /** Font row monospace size in px. */
  monoSize: Volatile<number>
  /** Font row terminal size in px. */
  termSize: Volatile<number>
}

/** Live theme and typography preferences. */
export const Config = z.object({
  preference: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE).volatile(),
  fontSize: fontSizeSchema(FONT_SIZE_SPECS.text).volatile(),
  codeFontSize: fontSizeSchema(FONT_SIZE_SPECS.code).volatile(),
  terminalFontSize: fontSizeSchema(FONT_SIZE_SPECS.terminal).volatile(),
  textFontFamily: z.string().default('').volatile(),
  codeFontFamily: z.string().default('').volatile(),
  terminalFontFamily: z.string().default('').volatile(),
  uiFamily: z.string().default(DEFAULT_UI_FAMILY).volatile(),
  uiSize: z.number().min(UI_SIZE_RANGE.min).max(UI_SIZE_RANGE.max).default(DEFAULT_UI_SIZE).volatile(),
  chatSize: z.number().min(CHAT_SIZE_RANGE.min).max(CHAT_SIZE_RANGE.max).default(DEFAULT_CHAT_SIZE).volatile(),
  monoFont: z.string().default(DEFAULT_MONO_FONT).volatile(),
  monoSize: z.number().min(MONO_SIZE_RANGE.min).max(MONO_SIZE_RANGE.max).default(DEFAULT_MONO_SIZE).volatile(),
  termSize: z.number().min(TERM_SIZE_RANGE.min).max(TERM_SIZE_RANGE.max).default(DEFAULT_TERM_SIZE).volatile(),
})

/** Supply the current palette before browser plugins start.
 * @param ctx Host plugin context.
 * @param config Validated live theme preferences.
 */
export function apply(ctx: Context, config: Config): void {
  // Installed system families for the Font row's interface menu; the
  // enumeration runs once per activation and the cache feeds the boot
  // bootstrap until the app restarts (newly installed fonts appear then).
  let uiFontsCache: readonly string[] = []
  void listSystemFontFamilies().then((families) => { uiFontsCache = families })
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.on('webserver/index-inject', (table) => {
    table.push(...bootThemeInjections(config.preference.get(), {
      text: config.fontSize.get(),
      code: config.codeFontSize.get(),
      terminal: config.terminalFontSize.get(),
    }, {
      text: config.textFontFamily.get(),
      code: config.codeFontFamily.get(),
      terminal: config.terminalFontFamily.get(),
    }, {
      uiFamily: config.uiFamily.get(),
      uiSize: config.uiSize.get(),
      chatSize: config.chatSize.get(),
      monoFont: config.monoFont.get(),
      monoSize: config.monoSize.get(),
      termSize: config.termSize.get(),
    }, uiFontsCache))
  }, { prepend: true })
}
