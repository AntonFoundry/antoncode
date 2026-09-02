/**
 * Compos-flavored theme registry for the frame (compos's themes.scm ported
 * to the token layer): a fixed set of named themes the M-x load-theme
 * palette lists, each an alias-token override layer over the base palettes.
 * Tokens are keyed by the full CSS variable name and every value carries a
 * { light, dark } pair (the pair keeps the layer legible if the user flips
 * the color scheme). `anton` is the untouched base — registering it gives
 * the palette a named home position.
 */
import type { ThemeDefinition } from '@deepseek-ai/dsh-client-ui-theme/client'

/** One palette entry: token name → per-scheme values. */
type Palette = Record<string, { light: string; dark: string }>

/** Shorthand: one value for both schemes (scheme-invariant token). */
const both = (light: string, dark: string): { light: string; dark: string } => ({ light, dark })

/** compos "paper" — the light design default from themes.scm. */
const paper: Palette = {
  '--dsw-alias-bg-base': both('#fdfcf8', '#17181c'),
  '--dsw-alias-bg-layer-1': both('#f4f0e6', '#1e2026'),
  '--dsw-alias-bg-layer-2': both('#ece7da', '#262932'),
  '--dsw-alias-bg-overlay': both('#fffdf9', '#22242c'),
  '--dsw-alias-label-primary': both('#1b1a17', '#e8e6e1'),
  '--dsw-alias-label-secondary': both('#57534a', '#a8a49a'),
  '--dsw-alias-border-l1': both('#e2dbc9', '#2c2f38'),
  '--dsw-alias-border-l2': both('#cbc4b1', '#3a3e4a'),
  '--dsw-alias-border-l3': both('#a8a08a', '#4a4f5e'),
  '--dsw-specific-sidebar-fill': both('#f4f0e6', '#1e2026'),
  '--dsw-alias-brand-primary': both('#26356b', '#8fa3e8'),
}

/** compos "sepia" — warm, dimmer paper for long sessions. */
const sepia: Palette = {
  '--dsw-alias-bg-base': both('#f6efe2', '#1c1712'),
  '--dsw-alias-bg-layer-1': both('#efe5d2', '#241d16'),
  '--dsw-alias-bg-layer-2': both('#e6d9c0', '#2d241b'),
  '--dsw-alias-bg-overlay': both('#faf4e8', '#272019'),
  '--dsw-alias-label-primary': both('#3a2f22', '#e8ddc9'),
  '--dsw-alias-label-secondary': both('#7a6a52', '#a89878'),
  '--dsw-alias-border-l1': both('#e0d2b8', '#32291f'),
  '--dsw-alias-border-l2': both('#c9b795', '#453a2c'),
  '--dsw-alias-border-l3': both('#a8956f', '#574936'),
  '--dsw-specific-sidebar-fill': both('#efe5d2', '#241d16'),
  '--dsw-alias-brand-primary': both('#7a5a1a', '#c9a55a'),
}

/** compos "midnight" — the dark base with an indigo-blue cast. */
const midnight: Palette = {
  '--dsw-alias-bg-base': both('#eef0f7', '#10141f'),
  '--dsw-alias-bg-layer-1': both('#ffffff', '#151a29'),
  '--dsw-alias-bg-layer-2': both('#e3e7f4', '#1b2236'),
  '--dsw-alias-bg-overlay': both('#f8f9fe', '#181e30'),
  '--dsw-alias-label-primary': both('#1c2340', '#dfe4f2'),
  '--dsw-alias-label-secondary': both('#5a6280', '#8f97b5'),
  '--dsw-alias-border-l1': both('#d9deee', '#232b42'),
  '--dsw-alias-border-l2': both('#bfc7e2', '#2e3854'),
  '--dsw-alias-border-l3': both('#98a3cc', '#3c4870'),
  '--dsw-specific-sidebar-fill': both('#e8ebf7', '#151a29'),
  '--dsw-alias-brand-primary': both('#31418f', '#7aa2ff'),
}

/** The palette the M-x load-theme lists. */
export const LAYOUT_THEMES: readonly ThemeDefinition[] = [
  { id: 'anton-dark', colorScheme: 'dark', tokens: {} },
  { id: 'paper', colorScheme: 'light', tokens: paper },
  { id: 'sepia', colorScheme: 'light', tokens: sepia },
  { id: 'midnight', colorScheme: 'dark', tokens: midnight },
]

/** The localStorage key holding the chosen theme id across loads. */
export const THEME_STORAGE_KEY = 'dsh.layout.theme'
