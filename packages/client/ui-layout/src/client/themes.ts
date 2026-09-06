/**
 * Compos-flavored theme registry for the frame (compos's themes.scm ported
 * to the token layer): a fixed set of named themes the M-x load-theme
 * palette lists, each an alias-token override layer over the base palettes.
 * Tokens are keyed by the full CSS variable name with one flat scheme-fixed
 * value: each palette targets ONE color scheme and carries every surface it
 * recolors — the definition's colorScheme flips the base palette, and the
 * overrides paint the named look over it. `anton-dark` is the untouched
 * base — registering it gives the palette a named home position.
 */
import type { ThemeDefinition } from '@deepseek-ai/dsh-client-ui-theme/client'

/** One palette entry: token name → the palette's scheme-fixed CSS value. */
type Palette = Record<string, string>

/** compos "paper" — the light design default from themes.scm. */
const paper: Palette = {
  '--dsw-alias-bg-base': '#fdfcf8',
  '--dsw-alias-bg-layer-1': '#f4f0e6',
  '--dsw-alias-bg-layer-2': '#ece7da',
  '--dsw-alias-bg-overlay': '#fffdf9',
  '--dsw-alias-label-primary': '#1b1a17',
  '--dsw-alias-label-secondary': '#57534a',
  '--dsw-alias-border-l1': '#e2dbc9',
  '--dsw-alias-border-l2': '#cbc4b1',
  '--dsw-alias-border-l3': '#a8a08a',
  '--dsw-specific-sidebar-fill': '#f4f0e6',
  '--dsw-alias-brand-primary': '#26356b',
}

/** compos "sepia" — warm, dimmer paper for long sessions. */
const sepia: Palette = {
  '--dsw-alias-bg-base': '#f6efe2',
  '--dsw-alias-bg-layer-1': '#efe5d2',
  '--dsw-alias-bg-layer-2': '#e6d9c0',
  '--dsw-alias-bg-overlay': '#faf4e8',
  '--dsw-alias-label-primary': '#3a2f22',
  '--dsw-alias-label-secondary': '#7a6a52',
  '--dsw-alias-border-l1': '#e0d2b8',
  '--dsw-alias-border-l2': '#c9b795',
  '--dsw-alias-border-l3': '#a8956f',
  '--dsw-specific-sidebar-fill': '#efe5d2',
  '--dsw-alias-brand-primary': '#7a5a1a',
}

/** compos "midnight" — the dark base with an indigo-blue cast. */
const midnight: Palette = {
  '--dsw-alias-bg-base': '#10141f',
  '--dsw-alias-bg-layer-1': '#151a29',
  '--dsw-alias-bg-layer-2': '#1b2236',
  '--dsw-alias-bg-overlay': '#181e30',
  '--dsw-alias-label-primary': '#dfe4f2',
  '--dsw-alias-label-secondary': '#8f97b5',
  '--dsw-alias-border-l1': '#232b42',
  '--dsw-alias-border-l2': '#2e3854',
  '--dsw-alias-border-l3': '#3c4870',
  '--dsw-specific-sidebar-fill': '#151a29',
  '--dsw-alias-brand-primary': '#7aa2ff',
}


/** nord — the dark base with nord's blue-grey cast. */
const nord: Palette = {
  '--dsw-alias-bg-base': '#2e3440',
  '--dsw-alias-bg-layer-1': '#3b4252',
  '--dsw-alias-bg-layer-2': '#434c5e',
  '--dsw-alias-bg-overlay': '#3b4252',
  '--dsw-alias-label-primary': '#eceff4',
  '--dsw-alias-label-secondary': '#d8dee9',
  '--dsw-alias-border-l1': '#3b4252',
  '--dsw-alias-border-l2': '#4c566a',
  '--dsw-alias-border-l3': '#5b6a82',
  '--dsw-specific-sidebar-fill': '#353b48',
  '--dsw-alias-brand-primary': '#88c0d0',
}

/** gruvbox — warm, high-contrast dark with the retro palette. */
const gruvbox: Palette = {
  '--dsw-alias-bg-base': '#282828',
  '--dsw-alias-bg-layer-1': '#3c3836',
  '--dsw-alias-bg-layer-2': '#504945',
  '--dsw-alias-bg-overlay': '#3c3836',
  '--dsw-alias-label-primary': '#ebdbb2',
  '--dsw-alias-label-secondary': '#d5c4a1',
  '--dsw-alias-border-l1': '#3c3836',
  '--dsw-alias-border-l2': '#504945',
  '--dsw-alias-border-l3': '#665c54',
  '--dsw-specific-sidebar-fill': '#32302f',
  '--dsw-alias-brand-primary': '#fabd2f',
}


/** monokai-pro — the doom theme this workspace actually runs (active in ~/.config/doom). */
const monokaiPro: Palette = {
  '--dsw-alias-bg-base': '#2d2a2e',
  '--dsw-alias-bg-layer-1': '#363338',
  '--dsw-alias-bg-layer-2': '#423f44',
  '--dsw-alias-bg-overlay': '#363338',
  '--dsw-alias-label-primary': '#fcfcfa',
  '--dsw-alias-label-secondary': '#c1c0bf',
  '--dsw-alias-border-l1': '#423f44',
  '--dsw-alias-border-l2': '#524f55',
  '--dsw-alias-border-l3': '#655f66',
  '--dsw-specific-sidebar-fill': '#363338',
  '--dsw-alias-brand-primary': '#ffd866',
}

/** doom-one — the default doom look (the commented pick in the config history). */
const doomOne: Palette = {
  '--dsw-alias-bg-base': '#282c34',
  '--dsw-alias-bg-layer-1': '#3f444f',
  '--dsw-alias-bg-layer-2': '#4b5263',
  '--dsw-alias-bg-overlay': '#3f444f',
  '--dsw-alias-label-primary': '#bbc2cf',
  '--dsw-alias-label-secondary': '#8b949e',
  '--dsw-alias-border-l1': '#3f444f',
  '--dsw-alias-border-l2': '#52596b',
  '--dsw-alias-border-l3': '#646b7f',
  '--dsw-specific-sidebar-fill': '#3b4048',
  '--dsw-alias-brand-primary': '#51afef',
}

/** doom-dracula — the transylvanian palette. */
const dracula: Palette = {
  '--dsw-alias-bg-base': '#282a36',
  '--dsw-alias-bg-layer-1': '#343746',
  '--dsw-alias-bg-layer-2': '#3b3d4f',
  '--dsw-alias-bg-overlay': '#343746',
  '--dsw-alias-label-primary': '#f8f8f2',
  '--dsw-alias-label-secondary': '#bdbdd4',
  '--dsw-alias-border-l1': '#343746',
  '--dsw-alias-border-l2': '#44475a',
  '--dsw-alias-border-l3': '#56576b',
  '--dsw-specific-sidebar-fill': '#2f313f',
  '--dsw-alias-brand-primary': '#bd93f9',
}

/** doom-tokyo-night — the neon-on-dark tokyo palette. */
const tokyoNight: Palette = {
  '--dsw-alias-bg-base': '#1a1b26',
  '--dsw-alias-bg-layer-1': '#1f2335',
  '--dsw-alias-bg-layer-2': '#292e42',
  '--dsw-alias-bg-overlay': '#1f2335',
  '--dsw-alias-label-primary': '#c0caf5',
  '--dsw-alias-label-secondary': '#a9b1d6',
  '--dsw-alias-border-l1': '#1f2335',
  '--dsw-alias-border-l2': '#2a2f47',
  '--dsw-alias-border-l3': '#3b4261',
  '--dsw-specific-sidebar-fill': '#16161e',
  '--dsw-alias-brand-primary': '#7aa2f7',
}

/** The palette the M-x load-theme lists. */
export const LAYOUT_THEMES: readonly ThemeDefinition[] = [
  { id: 'anton-dark', colorScheme: 'dark', tokens: {} },
  { id: 'paper', colorScheme: 'light', tokens: paper },
  { id: 'sepia', colorScheme: 'light', tokens: sepia },
  { id: 'midnight', colorScheme: 'dark', tokens: midnight },
  { id: 'nord', colorScheme: 'dark', tokens: nord },
  { id: 'gruvbox', colorScheme: 'dark', tokens: gruvbox },
  { id: 'monokai-pro', colorScheme: 'dark', tokens: monokaiPro },
  { id: 'doom-one', colorScheme: 'dark', tokens: doomOne },
  { id: 'dracula', colorScheme: 'dark', tokens: dracula },
  { id: 'tokyo-night', colorScheme: 'dark', tokens: tokyoNight },
]



/** The localStorage key holding the chosen theme id across loads. */
export const THEME_STORAGE_KEY = 'dsh.layout.theme'
