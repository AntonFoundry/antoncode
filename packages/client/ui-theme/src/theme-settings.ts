/** Theme preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Built-in preferences accepted at the registry and settings boundaries. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

/** Settings namespace owned by the theme plugin. */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected built-in theme preference. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** Theme preference persisted by the product Appearance row. */
export type ThemePreference = typeof THEME_PREFERENCES[number]

/** Default preference when the user-settings document has no override. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

/** Field carrying the selected monospace font family id. */
export const MONO_FONT_FIELD = 'monoFont'

/** Field carrying the selected monospace font size in px. */
export const MONO_SIZE_FIELD = 'monoSize'

/** One curated monospace family: stable id, display label, and CSS stack. */
export interface MonoFontOption {
  /** Settings-stable family id. */
  id: string
  /** Display label rendered in the settings row. */
  label: string
  /** Full CSS font-family value applied as `--ds-font-family-code`. */
  stack: string
}

/**
 * Curated monospace families. Every stack keeps a CJK tail so Windows does
 * not fall back to SimSun (same policy as the base code stack).
 */
export const MONO_FONTS: readonly MonoFontOption[] = Object.freeze([
  Object.freeze({
    id: 'monaco', label: 'Monaco',
    stack: "'Monaco', 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'PingFang SC', 'Microsoft YaHei'",
  }),
  Object.freeze({
    id: 'jetbrains-mono', label: 'JetBrains Mono',
    stack: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'PingFang SC', 'Microsoft YaHei'",
  }),
  Object.freeze({
    id: 'sf-mono', label: 'SF Mono',
    stack: "'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', 'PingFang SC', 'Microsoft YaHei'",
  }),
  Object.freeze({
    id: 'menlo', label: 'Menlo',
    stack: "'Menlo', 'SF Mono', Monaco, Consolas, 'Liberation Mono', 'PingFang SC', 'Microsoft YaHei'",
  }),
  Object.freeze({
    id: 'fira-code', label: 'Fira Code',
    stack: "'Fira Code', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', 'PingFang SC', 'Microsoft YaHei'",
  }),
  Object.freeze({
    id: 'cascadia-code', label: 'Cascadia Code',
    stack: "'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', 'PingFang SC', 'Microsoft YaHei'",
  }),
  Object.freeze({
    id: 'consolas', label: 'Consolas',
    stack: "'Consolas', Menlo, 'Liberation Mono', 'SF Mono', 'PingFang SC', 'Microsoft YaHei'",
  }),
])

/** Default monospace family id when the user-settings document has no override. */
export const DEFAULT_MONO_FONT = 'monaco'

/** Default monospace size in px. */
export const DEFAULT_MONO_SIZE = 15

/** Accepted monospace size range (px), inclusive. */
export const MONO_SIZE_RANGE = Object.freeze({ min: 10, max: 24 })

/**
 * Resolve one family id to its CSS stack.
 * @param id - a curated family id.
 * @returns the CSS font-family value; the default stack for unknown ids.
 */
export function monoFontStack(id: string): string {
  return MONO_FONTS.find(font => font.id === id)?.stack
    ?? monoFontStack(DEFAULT_MONO_FONT)
}

/**
 * Narrow one wire or registry value to a curated family id.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a curated family id.
 */
export function isMonoFont(value: unknown): value is string {
  return MONO_FONTS.some(font => font.id === value)
}

/** Durable theme section shared by the Host schema and the browser scope. */
export interface ThemeSettings {
  /** Selected built-in preference. */
  preference: ThemePreference
  /** Selected monospace family id. */
  monoFont: string
  /** Selected monospace size in px. */
  monoSize: number
}

/** Durable theme schema; also the wire envelope the browser scope validates against. */
export const ThemeSettingsSchema: z<ThemeSettings> = z.object({
  [THEME_PREFERENCE_FIELD]: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE),
  [MONO_FONT_FIELD]: z.string().default(DEFAULT_MONO_FONT),
  [MONO_SIZE_FIELD]: z.number()
    .min(MONO_SIZE_RANGE.min).max(MONO_SIZE_RANGE.max).default(DEFAULT_MONO_SIZE),
})

/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a built-in preference.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some(preference => preference === value)
}
