/**
 * Compos-flavored theme registry for the frame (compos's themes.scm ported
 * to the token layer): a fixed set of named themes the M-x load-theme
 * palette lists, each an alias-token override layer over the base palettes.
 * Tokens are keyed by the full CSS variable name with one flat scheme-fixed
 * value: each palette targets ONE color scheme and carries every surface it
 * recolors — the definition's colorScheme flips the base palette, and the
 * overrides paint the named look over it. `anton-dark` is the untouched
 * base — registering it gives the palette a named home position.
 *
 * Every theme carries a SIGNATURE accent: the brand primary, the active
 * mode-line fill, and hue-tinted surfaces/borders all take the theme's own
 * hue, so switching themes reads as an obvious color change — not a
 * background shuffle between near-identical darks.
 *
 * The hand-authored maps in this file are identity anchors, not complete
 * palettes: LAYOUT_THEMES runs every entry through `completeTheme()`
 * (theme-derive.ts, the opencode-style OKLCH derivation), which fills every
 * remaining base-sheet token — chat bubbles, composer input, markdown code
 * blocks, selectors, scrollbars, state colors, shadows — from the theme's own
 * bg/ink/accent/syntax anchors. Hand tokens always win; `anton-dark` (empty
 * tokens) stays the pure base.
 */
import type { ThemeDefinition, ThemeSyntaxPalette } from '@deepseek-ai/dsh-client-ui-theme/client'
import { completeTheme } from './theme-derive.ts'

/** One palette entry: token name → the palette's scheme-fixed CSS value. */
type Palette = Record<string, string>

/**
 * macOS Aqua (light): the Apple light-appearance materials — systemGray6
 * window base, white raised cards, systemBlue (`#007aff`) as the signature
 * accent and mode-line fill, traffic-light state hues (systemRed/Green/Orange),
 * overlay scrollbars, and soft large macOS card shadows.
 */
const macos: Palette = {
  '--dsw-alias-bg-base': '#f2f2f6',
  '--dsw-alias-bg-layer-1': '#ffffff',
  '--dsw-alias-bg-layer-2': '#f7f7fa',
  '--dsw-alias-bg-layer-3': '#ffffff',
  '--dsw-alias-bg-overlay': '#f5f5f8',
  '--dsw-alias-bg-module-platform': '#e9e9ee',
  '--dsw-alias-bg-multi-select': '#e9e9ee',
  '--dsw-alias-bg-skeleton': 'rgba(0, 0, 0, 0.05)',
  '--dsw-alias-border-l1': 'rgba(0, 0, 0, 0.08)',
  '--dsw-alias-border-l2': 'rgba(0, 0, 0, 0.12)',
  '--dsw-alias-border-l3': 'rgba(0, 0, 0, 0.16)',
  '--dsw-alias-border-l4': 'rgba(0, 0, 0, 0.2)',
  '--dsw-alias-brand-primary': '#007aff',
  '--dsw-alias-brand-text': '#1d1d1f',
  '--dsw-alias-mode-line-active': '#007aff',
  '--dsw-alias-button-primary-hover': '#0071e3',
  '--dsw-alias-interactive-bg-hover': 'rgba(0, 0, 0, 0.05)',
  '--dsw-alias-interactive-bg-active': 'rgba(0, 0, 0, 0.09)',
  '--dsw-alias-interactive-bg-hover-solid': '#e8e8ed',
  '--dsw-alias-interactive-bg-hover-accent': 'rgba(0, 122, 255, 0.12)',
  '--dsw-alias-label-primary': '#1d1d1f',
  '--dsw-alias-label-secondary': '#6e6e73',
  '--dsw-alias-label-tertiary': '#8e8e93',
  '--dsw-alias-label-caption': '#aeaeb2',
  '--dsw-alias-state-error-primary': '#ff3b30',
  '--dsw-alias-state-success-primary': '#34c759',
  '--dsw-alias-state-warn-primary': '#ff9500',
  '--dsw-alias-scrollbar-bg-l1': 'rgba(0, 0, 0, 0.22)',
  '--dsw-alias-scrollbar-bg-l2': 'rgba(0, 0, 0, 0.28)',
  '--dsw-alias-scrollbar-hover-l1': 'rgba(0, 0, 0, 0.36)',
  '--dsw-alias-scrollbar-hover-l2': 'rgba(0, 0, 0, 0.42)',
  '--dsw-alias-tooltip-bg': 'rgba(45, 45, 47, 0.9)',
  '--dsw-alias-toast-bg': '#2c2c2e',
  '--dsw-alias-markdown-citation': '#f0f0f3',
  '--dsw-alias-markdown-code-block': '#f6f6f8',
  '--dsw-alias-markdown-code-segment-selected': '#ffffff',
  '--dsw-alias-markdown-inline-code': '#ececf0',
  '--dsw-alias-markdown-tag': '#eef0f4',
  '--dsw-specific-bubble-highlight': '#d6e6ff',
  '--dsw-specific-bubble': '#eaf1ff',
  '--dsw-specific-input-major': '#ffffff',
  '--dsw-specific-selector': '#f0f0f3',
  '--dsw-specific-sidebar-fill': '#ececf1',
  '--dsw-specific-sidebar-nav-item-active-accent': 'rgba(0, 122, 255, 0.14)',
  '--dsw-specific-sidebar-nav-item-active': '#e3e3e9',
  '--dsw-specific-sidebar-nav-item-hover': '#e9e9ee',
  '--dsw-shadow-lv1': '0 1px 3px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.05)',
  '--dsw-shadow-lv1-blur': '0 4px 16px rgba(0, 0, 0, 0.05)',
  '--dsw-shadow-lv2': '0 2px 8px rgba(0, 0, 0, 0.06), 0 8px 24px rgba(0, 0, 0, 0.09)',
  '--dsw-shadow-lv3': '0 0 1px rgba(0, 0, 0, 0.12), 0 16px 48px rgba(0, 0, 0, 0.16)',
}

/** macos syntax hues: the theme's own shiki token palette. */
const macosSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#272ad8',
  '--shiki-token-string': '#d12f1b',
  '--shiki-token-comment': '#707f8c',
  '--shiki-token-keyword': '#ad3da4',
  '--shiki-token-parameter': '#3e8087',
  '--shiki-token-function': '#326d74',
  '--shiki-token-string-expression': '#366317',
  '--shiki-token-punctuation': '#3e3e3e',
  '--shiki-token-link': '#0f68a0',
}

/**
 * macOS Aqua (dark): the Apple dark-appearance materials — systemGray6/5
 * elevated surfaces, systemBlue dark (`#0a84ff`) accent, dark traffic-light
 * state hues, light overlay scrollbars, and the heavier shadows dark chrome
 * needs to separate near-black layers.
 */
const macosDark: Palette = {
  '--dsw-alias-bg-base': '#1c1c1e',
  '--dsw-alias-bg-layer-1': '#28282a',
  '--dsw-alias-bg-layer-2': '#232325',
  '--dsw-alias-bg-layer-3': '#2c2c2e',
  '--dsw-alias-bg-overlay': '#2c2c2e',
  '--dsw-alias-bg-module-platform': '#232326',
  '--dsw-alias-bg-multi-select': '#2c2c2e',
  '--dsw-alias-bg-skeleton': 'rgba(255, 255, 255, 0.07)',
  '--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.08)',
  '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.13)',
  '--dsw-alias-border-l3': 'rgba(255, 255, 255, 0.18)',
  '--dsw-alias-border-l4': 'rgba(255, 255, 255, 0.24)',
  '--dsw-alias-brand-primary': '#0a84ff',
  '--dsw-alias-brand-text': '#f5f5f7',
  '--dsw-alias-mode-line-active': '#0a84ff',
  '--dsw-alias-button-primary-hover': '#409cff',
  '--dsw-alias-interactive-bg-hover': 'rgba(255, 255, 255, 0.07)',
  '--dsw-alias-interactive-bg-active': 'rgba(255, 255, 255, 0.11)',
  '--dsw-alias-interactive-bg-hover-solid': '#2c2c2e',
  '--dsw-alias-interactive-bg-hover-accent': 'rgba(10, 132, 255, 0.2)',
  '--dsw-alias-label-primary': '#f5f5f7',
  '--dsw-alias-label-secondary': '#a1a1a6',
  '--dsw-alias-label-tertiary': '#7c7c81',
  '--dsw-alias-label-caption': '#636366',
  '--dsw-alias-state-error-primary': '#ff453a',
  '--dsw-alias-state-success-primary': '#30d158',
  '--dsw-alias-state-warn-primary': '#ff9f0a',
  '--dsw-alias-scrollbar-bg-l1': 'rgba(255, 255, 255, 0.25)',
  '--dsw-alias-scrollbar-bg-l2': 'rgba(255, 255, 255, 0.32)',
  '--dsw-alias-scrollbar-hover-l1': 'rgba(255, 255, 255, 0.4)',
  '--dsw-alias-scrollbar-hover-l2': 'rgba(255, 255, 255, 0.46)',
  '--dsw-alias-tooltip-bg': 'rgba(58, 58, 60, 0.95)',
  '--dsw-alias-toast-bg': '#3a3a3c',
  '--dsw-alias-markdown-citation': '#2e2e33',
  '--dsw-alias-markdown-code-block': '#26262a',
  '--dsw-alias-markdown-code-segment-selected': '#1c1c1e',
  '--dsw-alias-markdown-inline-code': '#333338',
  '--dsw-alias-markdown-tag': '#2c2c31',
  '--dsw-specific-bubble-highlight': '#31405a',
  '--dsw-specific-bubble': '#26303f',
  '--dsw-specific-input-major': '#28282a',
  '--dsw-specific-selector': '#2a2a2d',
  '--dsw-specific-sidebar-fill': '#212123',
  '--dsw-specific-sidebar-nav-item-active-accent': 'rgba(10, 132, 255, 0.22)',
  '--dsw-specific-sidebar-nav-item-active': '#323236',
  '--dsw-specific-sidebar-nav-item-hover': '#2a2a2d',
  '--dsw-shadow-lv1': '0 1px 3px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.3)',
  '--dsw-shadow-lv1-blur': '0 4px 16px rgba(0, 0, 0, 0.35)',
  '--dsw-shadow-lv2': '0 2px 8px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.45)',
  '--dsw-shadow-lv3': '0 0 1px rgba(0, 0, 0, 0.5), 0 16px 48px rgba(0, 0, 0, 0.55)',
}

/** macosDark syntax hues: the theme's own shiki token palette. */
const macosDarkSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#d0bf69',
  '--shiki-token-string': '#fc6a5d',
  '--shiki-token-comment': '#7f8c98',
  '--shiki-token-keyword': '#fc5fa3',
  '--shiki-token-parameter': '#dabaff',
  '--shiki-token-function': '#67b7a4',
  '--shiki-token-string-expression': '#ffd479',
  '--shiki-token-punctuation': '#dfe3ea',
  '--shiki-token-link': '#41a1c0',
}

/** compos "paper" — the light design default from themes.scm. */
const paper: Palette = {
  '--dsw-alias-bg-base': '#fdfcf8',
  '--dsw-alias-bg-layer-1': '#f3efe2',
  '--dsw-alias-bg-layer-2': '#ece6d4',
  '--dsw-alias-bg-overlay': '#fffdf9',
  '--dsw-alias-label-primary': '#1b1a17',
  '--dsw-alias-label-secondary': '#57534a',
  '--dsw-alias-border-l1': '#e0d8c2',
  '--dsw-alias-border-l2': '#c9c0a6',
  '--dsw-alias-border-l3': '#a89f85',
  '--dsw-specific-sidebar-fill': '#f3efe2',
  '--dsw-alias-brand-primary': '#2653c9',
  '--dsw-alias-mode-line-active': '#2f6bcc',
}

/** paper syntax hues: the theme's own shiki token palette. */
const paperSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#2653c9',
  '--shiki-token-string': '#2f7d4f',
  '--shiki-token-comment': '#8a8578',
  '--shiki-token-keyword': '#a83b7c',
  '--shiki-token-parameter': '#6d4a9e',
  '--shiki-token-function': '#0f7f8c',
  '--shiki-token-string-expression': '#48823a',
  '--shiki-token-punctuation': '#45423b',
  '--shiki-token-link': '#2653c9',
}

/** compos "sepia" — warm amber paper with a sun-baked accent. */
const sepia: Palette = {
  '--dsw-alias-bg-base': '#f7efdd',
  '--dsw-alias-bg-layer-1': '#f0e3c8',
  '--dsw-alias-bg-layer-2': '#e7d6b2',
  '--dsw-alias-bg-overlay': '#fbf4e4',
  '--dsw-alias-label-primary': '#3a2c18',
  '--dsw-alias-label-secondary': '#7d6a4c',
  '--dsw-alias-border-l1': '#e2d0ac',
  '--dsw-alias-border-l2': '#ccb687',
  '--dsw-alias-border-l3': '#ad9666',
  '--dsw-specific-sidebar-fill': '#f0e3c8',
  '--dsw-alias-brand-primary': '#b07d1e',
  '--dsw-alias-mode-line-active': '#a86f14',
}

/** sepia syntax hues: the theme's own shiki token palette. */
const sepiaSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#8a5a12',
  '--shiki-token-string': '#5f7d2f',
  '--shiki-token-comment': '#a09272',
  '--shiki-token-keyword': '#a34a6e',
  '--shiki-token-parameter': '#7c5295',
  '--shiki-token-function': '#3f6f8f',
  '--shiki-token-string-expression': '#6f7d33',
  '--shiki-token-punctuation': '#5c4a30',
  '--shiki-token-link': '#8a5a12',
}

/** compos "midnight" — deep indigo with a luminous periwinkle accent. */
const midnight: Palette = {
  '--dsw-alias-bg-base': '#0d1120',
  '--dsw-alias-bg-layer-1': '#141a30',
  '--dsw-alias-bg-layer-2': '#1c2444',
  '--dsw-alias-bg-overlay': '#18203a',
  '--dsw-alias-label-primary': '#e2e7fb',
  '--dsw-alias-label-secondary': '#93a0cc',
  '--dsw-alias-border-l1': '#253055',
  '--dsw-alias-border-l2': '#32406e',
  '--dsw-alias-border-l3': '#455694',
  '--dsw-specific-sidebar-fill': '#141a30',
  '--dsw-alias-brand-primary': '#82a7ff',
  '--dsw-alias-mode-line-active': '#4f74e3',
}

/** midnight syntax hues: the theme's own shiki token palette. */
const midnightSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#86c7ff',
  '--shiki-token-string': '#8fe3a9',
  '--shiki-token-comment': '#6b76a8',
  '--shiki-token-keyword': '#b7a5ff',
  '--shiki-token-parameter': '#f2a68c',
  '--shiki-token-function': '#82a7ff',
  '--shiki-token-string-expression': '#96e0c0',
  '--shiki-token-punctuation': '#c3cdf2',
  '--shiki-token-link': '#86c7ff',
}

/** nord — the dark base with nord's blue-grey cast and frost accent. */
const nord: Palette = {
  '--dsw-alias-bg-base': '#2b303b',
  '--dsw-alias-bg-layer-1': '#3b4252',
  '--dsw-alias-bg-layer-2': '#434c5e',
  '--dsw-alias-bg-overlay': '#3b4252',
  '--dsw-alias-label-primary': '#eceff4',
  '--dsw-alias-label-secondary': '#d8dee9',
  '--dsw-alias-border-l1': '#434c5e',
  '--dsw-alias-border-l2': '#4c566a',
  '--dsw-alias-border-l3': '#616e83',
  '--dsw-specific-sidebar-fill': '#353b48',
  '--dsw-alias-brand-primary': '#88c0d0',
  '--dsw-alias-mode-line-active': '#5e81ac',
}

/** nord syntax hues: the theme's own shiki token palette. */
const nordSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#b48ead',
  '--shiki-token-string': '#a3be8c',
  '--shiki-token-comment': '#616e88',
  '--shiki-token-keyword': '#81a1c1',
  '--shiki-token-parameter': '#d8dee9',
  '--shiki-token-function': '#88c0d0',
  '--shiki-token-string-expression': '#ebcb8b',
  '--shiki-token-punctuation': '#d8dee9',
  '--shiki-token-link': '#8fbcbb',
}

/** gruvbox — warm, high-contrast dark with the retro yellow accent. */
const gruvbox: Palette = {
  '--dsw-alias-bg-base': '#282828',
  '--dsw-alias-bg-layer-1': '#3c3836',
  '--dsw-alias-bg-layer-2': '#504945',
  '--dsw-alias-bg-overlay': '#3c3836',
  '--dsw-alias-label-primary': '#ebdbb2',
  '--dsw-alias-label-secondary': '#d5c4a1',
  '--dsw-alias-border-l1': '#45403d',
  '--dsw-alias-border-l2': '#57534e',
  '--dsw-alias-border-l3': '#6f6a60',
  '--dsw-specific-sidebar-fill': '#32302f',
  '--dsw-alias-brand-primary': '#fabd2f',
  '--dsw-alias-mode-line-active': '#d79921',
}

/** gruvbox syntax hues: the theme's own shiki token palette. */
const gruvboxSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#d3869b',
  '--shiki-token-string': '#b8bb26',
  '--shiki-token-comment': '#928374',
  '--shiki-token-keyword': '#fb4934',
  '--shiki-token-parameter': '#83a598',
  '--shiki-token-function': '#fabd2f',
  '--shiki-token-string-expression': '#8ec07c',
  '--shiki-token-punctuation': '#bdae93',
  '--shiki-token-link': '#83a598',
}

/** monokai-pro — the doom theme this workspace actually runs (active in ~/.config/doom). */
const monokaiPro: Palette = {
  '--dsw-alias-bg-base': '#2d2a2e',
  '--dsw-alias-bg-layer-1': '#373338',
  '--dsw-alias-bg-layer-2': '#443f46',
  '--dsw-alias-bg-overlay': '#373338',
  '--dsw-alias-label-primary': '#fcfcfa',
  '--dsw-alias-label-secondary': '#c6c4c2',
  '--dsw-alias-border-l1': '#474249',
  '--dsw-alias-border-l2': '#575158',
  '--dsw-alias-border-l3': '#6b646c',
  '--dsw-specific-sidebar-fill': '#373338',
  '--dsw-alias-brand-primary': '#ffd866',
  '--dsw-alias-mode-line-active': '#a9dc76',
}

/** monokaiPro syntax hues: the theme's own shiki token palette. */
const monokaiProSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#ab9df2',
  '--shiki-token-string': '#ffd866',
  '--shiki-token-comment': '#72696a',
  '--shiki-token-keyword': '#ff6188',
  '--shiki-token-parameter': '#fc9867',
  '--shiki-token-function': '#a9dc76',
  '--shiki-token-string-expression': '#78dce8',
  '--shiki-token-punctuation': '#fcfcfa',
  '--shiki-token-link': '#78dce8',
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
  '--dsw-alias-mode-line-active': '#2f7bd9',
}

/** doomOne syntax hues: the theme's own shiki token palette. */
const doomOneSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#ff6c6b',
  '--shiki-token-string': '#98be65',
  '--shiki-token-comment': '#68768c',
  '--shiki-token-keyword': '#c678dd',
  '--shiki-token-parameter': '#d19a66',
  '--shiki-token-function': '#51afef',
  '--shiki-token-string-expression': '#46d9ff',
  '--shiki-token-punctuation': '#bbc2cf',
  '--shiki-token-link': '#51afef',
}

/** doom-dracula — the transylvanian palette with a purple heart accent. */
const dracula: Palette = {
  '--dsw-alias-bg-base': '#282a36',
  '--dsw-alias-bg-layer-1': '#343746',
  '--dsw-alias-bg-layer-2': '#41445b',
  '--dsw-alias-bg-overlay': '#343746',
  '--dsw-alias-label-primary': '#f8f8f2',
  '--dsw-alias-label-secondary': '#bdbdd4',
  '--dsw-alias-border-l1': '#44475a',
  '--dsw-alias-border-l2': '#565a75',
  '--dsw-alias-border-l3': '#6b6f92',
  '--dsw-specific-sidebar-fill': '#2f313f',
  '--dsw-alias-brand-primary': '#bd93f9',
  '--dsw-alias-mode-line-active': '#8b5fd0',
}

/** dracula syntax hues: the theme's own shiki token palette. */
const draculaSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#bd93f9',
  '--shiki-token-string': '#f1fa8c',
  '--shiki-token-comment': '#6272a4',
  '--shiki-token-keyword': '#ff79c6',
  '--shiki-token-parameter': '#8be9fd',
  '--shiki-token-function': '#50fa7b',
  '--shiki-token-string-expression': '#8be9fd',
  '--shiki-token-punctuation': '#f8f8f2',
  '--shiki-token-link': '#8be9fd',
}

/** doom-tokyo-night — the neon-on-dark tokyo palette. */
const tokyoNight: Palette = {
  '--dsw-alias-bg-base': '#1a1b26',
  '--dsw-alias-bg-layer-1': '#1f2335',
  '--dsw-alias-bg-layer-2': '#2a2f47',
  '--dsw-alias-bg-overlay': '#1f2335',
  '--dsw-alias-label-primary': '#c0caf5',
  '--dsw-alias-label-secondary': '#a9b1d6',
  '--dsw-alias-border-l1': '#2a2f47',
  '--dsw-alias-border-l2': '#3b4261',
  '--dsw-alias-border-l3': '#565f89',
  '--dsw-specific-sidebar-fill': '#16161e',
  '--dsw-alias-brand-primary': '#7aa2f7',
  '--dsw-alias-mode-line-active': '#7aa2f7',
}

/** tokyoNight syntax hues: the theme's own shiki token palette. */
const tokyoNightSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#ff9e64',
  '--shiki-token-string': '#9ece6a',
  '--shiki-token-comment': '#565f89',
  '--shiki-token-keyword': '#bb9af7',
  '--shiki-token-parameter': '#7dcfff',
  '--shiki-token-function': '#7aa2f7',
  '--shiki-token-string-expression': '#89ddff',
  '--shiki-token-punctuation': '#a9b1d6',
  '--shiki-token-link': '#7dcfff',
}

/** The doom-emacs library ported from this machine (65 palettes). */
import { DOOM_THEMES } from './doom-themes.ts'

/** The curated compos palettes, the macOS Aqua pair, and the ported doom library. */
const CURATED_THEMES: readonly ThemeDefinition[] = [
  { id: 'anton-dark', colorScheme: 'dark', tokens: {} },
  { id: 'macos', colorScheme: 'light', tokens: macos , syntax: macosSyntax },
  { id: 'macos-dark', colorScheme: 'dark', tokens: macosDark , syntax: macosDarkSyntax },
  { id: 'paper', colorScheme: 'light', tokens: paper , syntax: paperSyntax },
  { id: 'sepia', colorScheme: 'light', tokens: sepia , syntax: sepiaSyntax },
  { id: 'midnight', colorScheme: 'dark', tokens: midnight , syntax: midnightSyntax },
  { id: 'nord', colorScheme: 'dark', tokens: nord , syntax: nordSyntax },
  { id: 'gruvbox', colorScheme: 'dark', tokens: gruvbox , syntax: gruvboxSyntax },
  { id: 'monokai-pro', colorScheme: 'dark', tokens: monokaiPro , syntax: monokaiProSyntax },
  { id: 'doom-one', colorScheme: 'dark', tokens: doomOne , syntax: doomOneSyntax },
  { id: 'dracula', colorScheme: 'dark', tokens: dracula , syntax: draculaSyntax },
  { id: 'tokyo-night', colorScheme: 'dark', tokens: tokyoNight , syntax: tokyoNightSyntax },
]

/** The palette the M-x load-theme lists, every entry completed to the full base-sheet token set. */
export const LAYOUT_THEMES: readonly ThemeDefinition[] = [
  ...CURATED_THEMES,
  // Doom themes whose id collides with a curated one (doom-one) are skipped —
  // the curated palette wins its name.
  ...DOOM_THEMES.filter(doom => !CURATED_THEMES.some(theme => theme.id === doom.id)),
].map(completeTheme)

/** The localStorage key holding the chosen theme id across loads. */
export const THEME_STORAGE_KEY = 'dsh.layout.theme'
