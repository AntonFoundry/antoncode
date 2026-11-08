/**
 * OpenCode's `oc-2` web palette mapped onto the Harness theme tokens.
 * Source: packages/ui/src/theme/themes/oc-2.json in the OpenCode fork at
 * fa1260d6ca484fe0fd868aa992ad81ab85343cf3. MIT, Copyright (c) 2025 opencode;
 * the complete notice ships in licenses/OpenCode.txt.
 *
 * Canvas, raised surfaces, ink and blue accents retain the upstream v2 values.
 * Light syntax and state text use darker steps from the same upstream ramps
 * where the original face would fall below 4.5:1 on Harness code surfaces.
 * Remaining Harness-specific surfaces use the existing theme completion.
 */
import type { ThemeDefinition, ThemeSyntaxPalette } from '@deepseek-ai/dsh-client-ui-theme/client'

const lightSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#007b80',
  '--shiki-token-string': '#1d783c',
  '--shiki-token-comment': '#5c5c5c',
  '--shiki-token-keyword': '#aa3576',
  '--shiki-token-parameter': '#954c27',
  '--shiki-token-function': '#5230c2',
  '--shiki-token-string-expression': '#1d783c',
  '--shiki-token-punctuation': '#5c5c5c',
  '--shiki-token-link': '#3b5cf6',
}

const darkSyntax: ThemeSyntaxPalette = {
  '--shiki-token-constant': '#93e9f6',
  '--shiki-token-string': '#96e3a6',
  '--shiki-token-comment': '#aeaeae',
  '--shiki-token-keyword': '#f799c6',
  '--shiki-token-parameter': '#ffc1a4',
  '--shiki-token-function': '#9e99f7',
  '--shiki-token-string-expression': '#96e3a6',
  '--shiki-token-punctuation': '#aeaeae',
  '--shiki-token-link': '#a2bcff',
}

/** Scheme-fixed OpenCode web palettes, completed by the existing registry. */
export const OPENCODE_THEMES: readonly ThemeDefinition[] = [
  {
    id: 'opencode',
    colorScheme: 'light',
    tokens: {
      '--dsw-alias-bg-base': '#ffffff',
      '--dsw-alias-bg-layer-1': '#fafafa',
      '--dsw-alias-bg-layer-2': '#f2f2f2',
      '--dsw-alias-bg-layer-3': '#eeeeee',
      '--dsw-alias-bg-overlay': '#fafafa',
      '--dsw-alias-label-primary': '#161616',
      '--dsw-alias-label-secondary': '#5c5c5c',
      '--dsw-alias-brand-primary': '#3b5cf6',
      '--dsw-alias-brand-primary-invert': '#ffffff',
      '--dsw-alias-link': '#3b5cf6',
      '--dsw-alias-mode-line-active': '#3b5cf6',
      '--dsw-alias-state-error-primary': '#b82d35',
      '--dsw-alias-state-success-primary': '#1d783c',
      '--dsw-alias-state-warn-primary': '#68552b',
      '--dsw-alias-markdown-code-block': '#fafafa',
      '--dsw-alias-markdown-code-block-banner': '#fafafa',
      '--dsw-specific-sidebar-fill': '#fafafa',
      '--dsw-specific-input-major': '#fafafa',
    },
    syntax: lightSyntax,
  },
  {
    id: 'opencode-dark',
    colorScheme: 'dark',
    tokens: {
      '--dsw-alias-bg-base': '#161616',
      '--dsw-alias-bg-layer-1': '#242424',
      '--dsw-alias-bg-layer-2': '#2e2e2e',
      '--dsw-alias-bg-layer-3': '#3a3a3a',
      '--dsw-alias-bg-overlay': '#242424',
      '--dsw-alias-label-primary': '#fafafa',
      '--dsw-alias-label-secondary': '#aeaeae',
      '--dsw-alias-brand-primary': '#3b5cf6',
      '--dsw-alias-brand-primary-invert': '#ffffff',
      '--dsw-alias-link': '#a2bcff',
      '--dsw-alias-mode-line-active': '#3b5cf6',
      '--dsw-alias-state-error-primary': '#f17471',
      '--dsw-alias-state-success-primary': '#6bd586',
      '--dsw-alias-state-warn-primary': '#f2cf76',
      '--dsw-alias-markdown-code-block': '#242424',
      '--dsw-alias-markdown-code-block-banner': '#242424',
      '--dsw-specific-sidebar-fill': '#080808',
      '--dsw-specific-input-major': '#242424',
    },
    syntax: darkSyntax,
  },
]
