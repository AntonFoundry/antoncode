/** Host registration for the browser theme preference and pre-plugin palette. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { injectBootTheme } from './boot-theme.ts'
import {
  DEFAULT_CHAT_SIZE, DEFAULT_MONO_FONT, DEFAULT_MONO_SIZE, DEFAULT_PREFERENCE,
  DEFAULT_TERM_SIZE, DEFAULT_UI_FAMILY, DEFAULT_UI_SIZE, THEME_SETTINGS_NAMESPACE,
  ThemeSettingsSchema, type ThemeSettings,
} from './theme-settings.ts'
import { listSystemFontFamilies } from './system-fonts.ts'

export {
  CHAT_SIZE_FIELD, CHAT_SIZE_RANGE, CHAT_ZOOM_BASE, DEFAULT_CHAT_SIZE,
  DEFAULT_MONO_FONT, DEFAULT_MONO_SIZE, DEFAULT_PREFERENCE, DEFAULT_TERM_SIZE,
  DEFAULT_UI_FAMILY, DEFAULT_UI_SIZE, MONO_FONTS, MONO_FONT_FIELD, MONO_SIZE_FIELD,
  MONO_SIZE_RANGE, TERM_SIZE_FIELD, TERM_SIZE_RANGE, THEME_PREFERENCE_FIELD,
  THEME_PREFERENCES, THEME_SETTINGS_NAMESPACE, UI_FONTS, UI_FONT_FIELD,
  UI_SIZE_FIELD, UI_SIZE_RANGE, UI_ZOOM_BASE, isMonoFont, monoFontStack,
  uiFamilyStack,
  type MonoFontOption, type ThemePreference, type ThemeSettings, type UiFontOption,
} from './theme-settings.ts'
export { listSystemFontFamilies, parseFontFileFamilies } from './system-fonts.ts'

const THEME_NAMESPACE = settingsNamespace(THEME_SETTINGS_NAMESPACE)

/** Schema defaults for compositions without a settings provider. */
const DEFAULT_SECTION: ThemeSettings = {
  preference: DEFAULT_PREFERENCE,
  uiFamily: DEFAULT_UI_FAMILY, uiSize: DEFAULT_UI_SIZE, chatSize: DEFAULT_CHAT_SIZE,
  monoFont: DEFAULT_MONO_FONT, monoSize: DEFAULT_MONO_SIZE, termSize: DEFAULT_TERM_SIZE,
}

/** Read the registered section or the schema defaults without a settings provider. */
function readSection(ctx: Context): ThemeSettings {
  const settings = ctx.get('settings')
  const section = settings === undefined ? undefined : settings.get(THEME_NAMESPACE) as ThemeSettings | undefined
  return section ?? DEFAULT_SECTION
}

/**
 * Register the durable theme section and initial-theme index transform when
 * their optional Host services are composed.
 * @param ctx - Host context that may acquire settings and HTTP services.
 */
export function apply(ctx: Context): void {
  // Installed system families for the Font panel's interface menu; the
  // enumeration runs once per activation and the cache feeds the boot
  // bootstrap until the app restarts (newly installed fonts appear then).
  let uiFontsCache: readonly string[] = []
  void listSystemFontFamilies().then((families) => { uiFontsCache = families })
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(THEME_NAMESPACE, ThemeSettingsSchema)
  })
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () => httpCtx.webServer.tapIndex((html) => {
        const { preference, ...fonts } = readSection(ctx)
        return injectBootTheme(html, preference, fonts, uiFontsCache)
      }),
      'client-ui-theme: initial theme bootstrap',
    )
  })
}
