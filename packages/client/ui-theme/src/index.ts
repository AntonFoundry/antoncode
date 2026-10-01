/** Host registration for the browser theme preference and pre-plugin palette. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { injectBootTheme, type BootFonts } from './boot-theme.ts'
import {
  DEFAULT_MONO_FONT, DEFAULT_MONO_SIZE, DEFAULT_PREFERENCE, THEME_SETTINGS_NAMESPACE,
  ThemeSettingsSchema, type ThemeSettings,
} from './theme-settings.ts'

export {
  DEFAULT_MONO_FONT, DEFAULT_MONO_SIZE, DEFAULT_PREFERENCE, MONO_FONTS, MONO_FONT_FIELD,
  MONO_SIZE_FIELD, MONO_SIZE_RANGE, THEME_PREFERENCE_FIELD, THEME_PREFERENCES,
  THEME_SETTINGS_NAMESPACE, isMonoFont, monoFontStack,
  type MonoFontOption, type ThemePreference, type ThemeSettings,
} from './theme-settings.ts'

const THEME_NAMESPACE = settingsNamespace(THEME_SETTINGS_NAMESPACE)

/** Read the registered section or the schema defaults without a settings provider. */
function readSection(ctx: Context): ThemeSettings {
  const settings = ctx.get('settings')
  if (settings === undefined) {
    return { preference: DEFAULT_PREFERENCE, monoFont: DEFAULT_MONO_FONT, monoSize: DEFAULT_MONO_SIZE }
  }
  const section = settings.get(THEME_NAMESPACE) as ThemeSettings | undefined
  if (section === undefined) {
    return { preference: DEFAULT_PREFERENCE, monoFont: DEFAULT_MONO_FONT, monoSize: DEFAULT_MONO_SIZE }
  }
  return section
}

/**
 * Register the durable theme section and initial-theme index transform when
 * their optional Host services are composed.
 * @param ctx - Host context that may acquire settings and HTTP services.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(THEME_NAMESPACE, ThemeSettingsSchema)
  })
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () => httpCtx.webServer.tapIndex((html) => {
        const section = readSection(ctx)
        const fonts: BootFonts = { monoFont: section.monoFont, monoSize: section.monoSize }
        return injectBootTheme(html, section.preference, fonts)
      }),
      'client-ui-theme: initial theme bootstrap',
    )
  })
}
