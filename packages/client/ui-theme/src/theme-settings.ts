/** Theme preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Built-in preferences accepted at the registry and settings boundaries. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

/** Settings namespace owned by the theme plugin. */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected built-in theme preference. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** Field carrying the conversation content font size. */
export const FONT_SIZE_FIELD = 'fontSize'

/** Theme preference persisted by the product Appearance row. */
export type ThemePreference = typeof THEME_PREFERENCES[number]

/** Default preference when the user-settings document has no override. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

/** Smallest accepted content font size (px). */
export const FONT_SIZE_MIN = 10

/** Largest accepted content font size (px). */
export const FONT_SIZE_MAX = 22

/** Content font size when the user-settings document has no override (px). */
export const DEFAULT_FONT_SIZE = 14

/** Independently configurable font roles. */
export const FONT_ROLES = ['text', 'code', 'terminal'] as const

/** One configurable font role: interface text, code, or the sidebar terminal. */
export type FontRole = typeof FONT_ROLES[number]

/** Settings field, body variable, and accepted integer px range of one role's font size. */
export interface FontSizeSpec {
  /** Settings field carrying the size. */
  field: string
  /** Body variable carrying the size in px. */
  variable: string
  /** Smallest accepted size. */
  min: number
  /** Largest accepted size. */
  max: number
  /** Size when the user-settings document has no override. */
  default: number
}

/**
 * Font sizes by role. `text` is the conversation content size; `code` is the
 * code-block size (inline code stays 1px larger); `terminal` is the sidebar
 * terminal cell font size.
 */
export const FONT_SIZE_SPECS = {
  text: { field: FONT_SIZE_FIELD, variable: '--dsh-content-font-size', min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, default: DEFAULT_FONT_SIZE },
  code: { field: 'codeFontSize', variable: '--dsh-code-font-size', min: 10, max: 16, default: 11 },
  terminal: { field: 'terminalFontSize', variable: '--dsh-terminal-font-size', min: 10, max: 20, default: 13 },
} as const satisfies Record<FontRole, FontSizeSpec>

/** Integer px font sizes by role. */
export type FontSizes = Readonly<Record<FontRole, number>>

/** Default font sizes by role. */
export const DEFAULT_FONT_SIZES: FontSizes = Object.freeze({
  text: FONT_SIZE_SPECS.text.default, code: FONT_SIZE_SPECS.code.default, terminal: FONT_SIZE_SPECS.terminal.default,
})

/** Settings field carrying each role's font-family list. */
export const FONT_FAMILY_FIELDS = {
  text: 'textFontFamily',
  code: 'codeFontFamily',
  terminal: 'terminalFontFamily',
} as const satisfies Record<FontRole, string>

/**
 * Body variable carrying one role's normalized font list; the token sheet
 * places it ahead of that role's built-in stack.
 * @param kind - font role.
 * @returns the CSS custom property name.
 */
export function fontFamilyVariable(kind: FontRole): string {
  return `--dsh-font-family-${kind}`
}

/** Normalized CSS font-family lists by role; `''` selects the built-in stack. */
export type FontFamilies = Readonly<Record<FontRole, string>>
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
 * Resolve one monospace family id to its CSS stack.
 * @param id - a curated family id.
 * @returns the CSS font-family value; the default stack for unknown ids.
 */
export function monoFontStack(id: string): string {
  return MONO_FONTS.find(font => font.id === id)?.stack
    ?? monoFontStack(DEFAULT_MONO_FONT)
}

/**
 * Narrow one wire or registry value to a curated monospace family id.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a curated family id.
 */
export function isMonoFont(value: unknown): value is string {
  return MONO_FONTS.some(font => font.id === value)
}

/** Field carrying the selected UI (proportional) font family name. */
export const UI_FONT_FIELD = 'uiFamily'

/** Field carrying the interface base text size in px. */
export const UI_SIZE_FIELD = 'uiSize'

/** Field carrying the chat-pane base text size in px. */
export const CHAT_SIZE_FIELD = 'chatSize'

/** Field carrying the terminal font size in px. */
export const TERM_SIZE_FIELD = 'termSize'

/** One curated UI family: stable id, display label, and CSS stack. */
export interface UiFontOption {
  /** Settings-stable family id. */
  id: string
  /** Display label rendered in the settings row. */
  label: string
  /** Full CSS font-family value applied as `--dsw-font-family`. */
  stack: string
}

/** The shipped proportional stack (base.css `--dsw-font-family` default). */
export const SYSTEM_UI_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', "
  + "'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"

/**
 * Curated UI families. Every stack keeps the CJK tail so Windows does not
 * fall back to SimSun for Chinese copy.
 */
export const UI_FONTS: readonly UiFontOption[] = Object.freeze([
  Object.freeze({ id: 'system', label: 'System', stack: SYSTEM_UI_STACK }),
  Object.freeze({
    id: 'helvetica', label: 'Helvetica Neue',
    stack: "'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  }),
  Object.freeze({
    id: 'arial', label: 'Arial',
    stack: "Arial, Helvetica, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  }),
  Object.freeze({
    id: 'georgia', label: 'Georgia',
    stack: "Georgia, 'Times New Roman', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', serif",
  }),
  Object.freeze({
    id: 'rounded', label: 'Rounded',
    stack: "ui-rounded, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  }),
])

/** Default UI family name when the user-settings document has no override. */
export const DEFAULT_UI_FAMILY = 'system'

/** Fallback tail appended after a user-selected UI family. */
const UI_FAMILY_FALLBACK = SYSTEM_UI_STACK

/**
 * Build the CSS stack for a user-selected UI family: the family quoted
 * first, then the shipped system tail so CJK and missing glyphs fall back
 * predictably.
 * @param family - any installed family name, or 'system'.
 * @returns the CSS font-family value.
 */
export function uiFamilyStack(family: string): string {
  if (family === DEFAULT_UI_FAMILY || family.trim() === '') return SYSTEM_UI_STACK
  return `'${family.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', ${UI_FAMILY_FALLBACK}`
}

/** Accepted interface base size range (px), inclusive. */
export const UI_SIZE_RANGE = Object.freeze({ min: 12, max: 20 })

/** Default interface base size in px — the shipped UI text base. */
export const DEFAULT_UI_SIZE = 14

/** Interface zoom implementation base: the size that maps to zoom 1. */
export const UI_ZOOM_BASE = 14

/** Accepted chat base size range (px), inclusive. */
export const CHAT_SIZE_RANGE = Object.freeze({ min: 12, max: 22 })

/** Default chat base size in px — the shipped markdown text base. */
export const DEFAULT_CHAT_SIZE = 16

/** Chat zoom implementation base: the size that maps to zoom 1. */
export const CHAT_ZOOM_BASE = 16

/** Default terminal size in px. */
export const DEFAULT_TERM_SIZE = 13

/** Accepted terminal size range (px), inclusive. */
export const TERM_SIZE_RANGE = Object.freeze({ min: 10, max: 24 })

/** Durable theme section shared by the Host schema and the browser scope. */
export interface ThemeSettings {
  /** Selected built-in preference. */
  preference: ThemePreference
  /** Selected monospace family id. */
  monoFont: string
  /** Selected monospace size in px. */
  monoSize: number
  /** Selected UI family name, or 'system'. */
  uiFamily: string
  /** Interface base text size in px. */
  uiSize: number
  /** Chat-pane base text size in px. */
  chatSize: number
  /** Terminal font size in px. */
  termSize: number
  /** Conversation content font size in px (integer within {@link FONT_SIZE_MIN}..{@link FONT_SIZE_MAX}). */
  fontSize: number
  /** Code-block font size in px (integer within the {@link FONT_SIZE_SPECS} `code` range). */
  codeFontSize: number
  /** Sidebar terminal font size in px (integer within the {@link FONT_SIZE_SPECS} `terminal` range). */
  terminalFontSize: number
  /** Interface and body text fonts placed before the built-in stack; `''` keeps the built-in stack. */
  textFontFamily: string
  /** Code fonts placed before the built-in code stack; `''` keeps the built-in stack. */
  codeFontFamily: string
  /** Sidebar terminal fonts placed before the built-in terminal stack; `''` keeps the built-in stack. */
  terminalFontFamily: string
}

/**
 * Integer px schema for one role's font size.
 * @param spec - the role's range and default.
 * @returns the validated number schema.
 */
export function fontSizeSchema(spec: FontSizeSpec): z<number> {
  return z.number().step(1).min(spec.min).max(spec.max).default(spec.default)
}

/**
 * Collect every role's size from a settings section.
 * @param section - accepted theme settings.
 * @returns integer px sizes by role.
 */
export function sectionFontSizes(section: ThemeSettings): FontSizes {
  return Object.freeze({ text: section.fontSize, code: section.codeFontSize, terminal: section.terminalFontSize })
}

/**
 * Whether one value is an accepted size for a role.
 * @param role - font role.
 * @param px - candidate size.
 * @returns true for an integer within the role's range.
 */
export function isFontSize(role: FontRole, px: number): boolean {
  const spec = FONT_SIZE_SPECS[role]
  return Number.isInteger(px) && px >= spec.min && px <= spec.max
}

/** Durable theme schema; also the wire envelope the browser scope validates against. */
export const ThemeSettingsSchema: z<ThemeSettings> = z.object({
  [THEME_PREFERENCE_FIELD]: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE),
  [FONT_SIZE_FIELD]: fontSizeSchema(FONT_SIZE_SPECS.text),
  [FONT_SIZE_SPECS.code.field]: fontSizeSchema(FONT_SIZE_SPECS.code),
  [FONT_SIZE_SPECS.terminal.field]: fontSizeSchema(FONT_SIZE_SPECS.terminal),
  [FONT_FAMILY_FIELDS.text]: z.string().default(''),
  [FONT_FAMILY_FIELDS.code]: z.string().default(''),
  [FONT_FAMILY_FIELDS.terminal]: z.string().default(''),
  [MONO_FONT_FIELD]: z.string().default(DEFAULT_MONO_FONT),
  [MONO_SIZE_FIELD]: z.number()
    .min(MONO_SIZE_RANGE.min).max(MONO_SIZE_RANGE.max).default(DEFAULT_MONO_SIZE),
  [UI_FONT_FIELD]: z.string().default(DEFAULT_UI_FAMILY),
  [UI_SIZE_FIELD]: z.number()
    .min(UI_SIZE_RANGE.min).max(UI_SIZE_RANGE.max).default(DEFAULT_UI_SIZE),
  [CHAT_SIZE_FIELD]: z.number()
    .min(CHAT_SIZE_RANGE.min).max(CHAT_SIZE_RANGE.max).default(DEFAULT_CHAT_SIZE),
  [TERM_SIZE_FIELD]: z.number()
    .min(TERM_SIZE_RANGE.min).max(TERM_SIZE_RANGE.max).default(DEFAULT_TERM_SIZE),
})

/** CSS Fonts generic and system family keywords, which must stay unquoted. */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif',
  'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont',
])

/**
 * Normalize user input into a CSS font-family list. Names are comma separated;
 * quotes, backslashes, angle brackets, and control characters are dropped, and
 * every non-generic name is double-quoted, so the result is always a valid list
 * safe to embed in inline CSS and boot scripts. Normalizing a result returns it unchanged.
 * @param value - user-entered or stored font list.
 * @returns the normalized list, or `''` when no family name remains.
 */
export function normalizeFontFamily(value: string): string {
  return value.split(',')
    .map(name => name.replace(/["'\\<>\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim())
    .filter(name => name !== '')
    .map(name => GENERIC_FAMILIES.has(name.toLowerCase()) ? name : `"${name}"`)
    .join(', ')
}

/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a built-in preference.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some(preference => preference === value)
}
