/**
 * Opencode-style palette completion for the frame's theme registry
 * (antoncode-ui `packages/ui/src/theme/{color,resolve}.ts` compacted onto the
 * `--dsw-*` alias layer). A theme definition hand-tunes only its identity
 * tokens — the background ramp, the label ladder, the brand accent, the
 * sidebar fill, and the `--shiki-*` syntax hues; {@link completeTheme} derives
 * every remaining alias/specific/shadow token the base sheets define from those
 * anchors, so chat bubbles, the composer input, markdown code blocks,
 * selectors, scrollbars, and state colors all follow the theme instead of
 * falling through to the anton-dark/light base palette.
 *
 * Hand tokens are authoritative anchors and are never overwritten; derivation
 * fills only absent tokens. All color math runs in OKLCH (perceptual blending,
 * gamut-fit output) with ink-alpha ladders over the theme's own background,
 * mirroring opencode's `alphaTone`/`borderTone`/`on()` helpers. Pure functions,
 * deterministic output; `anton-dark` (empty tokens) is skipped — it IS the
 * base palette.
 */
import type { ThemeDefinition, ThemeSyntaxPalette } from '@deepseek-ai/dsh-client-ui-theme/client'

/** CSS value of one completed token: a solid hex or an `rgba()` ink-alpha string. */
type TokenValue = string

/** OKLCH color: lightness 0–1, chroma ≥ 0, hue in degrees. */
interface Oklch {
  l: number
  c: number
  h: number
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const wrapHue = (v: number): number => ((v % 360) + 360) % 360

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const digits = hex.replace('#', '')
  const full = digits.length <= 4
    ? digits.split('').map(ch => ch + ch).join('')
    : digits
  const num = parseInt(full.length === 8 ? full.slice(0, 6) : full, 16)
  return { r: ((num >> 16) & 255) / 255, g: ((num >> 8) & 255) / 255, b: (num & 255) / 255 }
}

function rgbToHex(r: number, g: number, b: number): string {
  const channel = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

function hexToOklch(hex: string): Oklch {
  const srgb = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const { r, g, b } = hexToRgb(hex)
  const lr = srgb(r); const lg = srgb(g); const lb = srgb(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    c: Math.sqrt(a * a + b2 * b2),
    h: wrapHue(Math.atan2(b2, a) * (180 / Math.PI)),
  }
}

/** Convert OKLCH to hex, compressing chroma until the value fits sRGB. */
function oklchToHex(color: Oklch): string {
  const base = { l: clamp01(color.l), c: Math.max(0, color.c), h: wrapHue(color.h) }
  const render = (c: number): { r: number; g: number; b: number } | undefined => {
    const rad = (base.h * Math.PI) / 180
    const A = c * Math.cos(rad)
    const B = c * Math.sin(rad)
    const l = base.l + 0.3963377774 * A + 0.2158037573 * B
    const m = base.l - 0.1055613458 * A - 0.0638541728 * B
    const s = base.l - 0.0894841775 * A - 1.291485548 * B
    const linear = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
    // Linear RGB is physically bounded [0,1]; clamp before the transfer so
    // boundary rounding (l = 1 lands at 1 + 2e-16 through the matrix) cannot
    // NaN the fractional exponent, while genuine out-of-gamut chroma still
    // overshoots by real margins and rejects below.
    const r = linear(clamp01(4.0767416621 * l ** 3 - 3.3077115913 * m ** 3 + 0.2309699292 * s ** 3))
    const g = linear(clamp01(-1.2684380046 * l ** 3 + 2.6097574011 * m ** 3 - 0.3413193965 * s ** 3))
    const b = linear(clamp01(-0.0041960863 * l ** 3 - 0.7034186147 * m ** 3 + 1.707614707 * s ** 3))
    return r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1 ? { r, g, b } : undefined
  }
  let c = base.c
  let rgb = render(c)
  for (let i = 0; i < 24 && rgb === undefined; i++) {
    c *= 0.9
    rgb = render(c)
  }
  // Chroma compression converges: after 24 rounds any registry-reachable
  // chroma is achromatic and inside the gamut, so the guard below is a hard
  // net against future callers passing extreme colors, not a data path.
  /* v8 ignore next 2 */
  if (rgb === undefined) throw new Error('oklchToHex: gamut fit did not converge')
  return rgbToHex(rgb.r, rgb.g, rgb.b)
}

/** Lightness/chroma/hue shift in OKLCH; chroma is a multiplier, hue an offset. */
function shift(hex: string, delta: { l?: number; c?: number; h?: number }): string {
  const base = hexToOklch(hex)
  return oklchToHex({
    l: base.l + (delta.l ?? 0),
    c: base.c * (delta.c ?? 1),
    h: base.h + (delta.h ?? 0),
  })
}

/** Perceptual OKLCH mix; `amount` is the second color's share. */
function mix(a: string, b: string, amount: number): string {
  const ca = hexToOklch(a)
  const cb = hexToOklch(b)
  const dh = ((((cb.h - ca.h) % 360) + 540) % 360) - 180
  return oklchToHex({
    l: ca.l + (cb.l - ca.l) * amount,
    c: ca.c + (cb.c - ca.c) * amount,
    h: ca.h + dh * amount,
  })
}

/** Alpha string of `color` (the rgb channels carried verbatim, no blending). */
function alphaOf(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`
}

/** White or black — whichever contrasts more with `fill` (opencode `on()`). */
function onColor(fill: string): string {
  const { r, g, b } = hexToRgb(fill)
  const lift = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const lum = 0.2126 * lift(r) + 0.7152 * lift(g) + 0.0722 * lift(b)
  return lum > 0.179 ? '#000000' : '#ffffff'
}

/**
 * Nudge `hue` into the readable-on-surface band (opencode `content()`): dark
 * schemes need light values, light schemes dark ones, and both want more
 * chroma than the raw face color carries.
 */
function readableBand(hex: string, dark: boolean): string {
  const base = hexToOklch(hex)
  return shift(hex, dark
    ? { l: (Math.max(0, 0.86 - base.l)) * 0.55, c: 1.25 }
    : { l: -Math.max(0, base.l - 0.38) * 0.55, c: 1.18 })
}

/** The theme syntax hues every completed theme carries (hand or derived). */
type Syntax = ThemeSyntaxPalette

/** Anchors extracted from a definition's hand tokens. */
interface Anchors {
  dark: boolean
  bg: string
  layer1: string
  ink: string
  inkSecondary: string
  accent: string
  syntax: Syntax
  /** Red/amber/green state seeds, resolved from hand tokens or syntax hues. */
  error: string
  warn: string
  success: string
}

/** First syntax hue whose hue angle sits within `window` degrees of `target`. */
function syntaxHueNear(syntax: Syntax, target: number, window: number): string | undefined {
  let best: { value: string; distance: number } | undefined
  for (const value of Object.values(syntax)) {
    const oklch = hexToOklch(value)
    // Achromatic faces never seed a state color: the 0.09 chroma floor keeps
    // out white/gray parameters (atan2 rounding noise) and cream foregrounds
    // (~0.06) while true amber/green/red faces start around 0.11.
    if (oklch.c < 0.09) continue
    const distance = Math.abs((((oklch.h - target) % 360) + 540) % 360 - 180)
    if (distance <= window && (best === undefined || distance < best.distance)) {
      best = { value, distance }
    }
  }
  return best?.value
}

/**
 * Resolve the red/amber/green state seeds: a hand token wins, then the syntax
 * hue closest to the target hue band (every doom theme's keyword/constant/
 * string faces carry the theme's red/amber/green), then the shipped neutral
 * hue nudged toward the theme's chroma. Deterministic and documented.
 */
function stateSeeds(tokens: Record<string, string>, syntax: Syntax, dark: boolean): { error: string; warn: string; success: string } {
  const fallback = (base: string): string => shift(base, { c: 1.05 })
  const near = (hand: string | undefined, target: number, base: string): string =>
    // 15°: OKLCH places red at ~29° with magenta at ~350°, so a wide window
    // seeds errors from pink keywords; a tight window takes only genuine
    // red/amber/green faces and lets the rest fall back to the neutral seed.
    hand ?? syntaxHueNear(syntax, target, 15) ?? fallback(base)
  return {
    error: near(tokens['--dsw-alias-state-error-primary'], 27, dark ? '#ff453a' : '#e51919'),
    warn: near(tokens['--dsw-alias-state-warn-primary'], 70, '#f59e0b'),
    success: near(tokens['--dsw-alias-state-success-primary'], 145, '#22c55e'),
  }
}

function anchorsOf(def: ThemeDefinition): Anchors | undefined {
  const tokens = def.tokens
  if (Object.keys(tokens).length === 0) return undefined
  const dark = def.colorScheme === 'dark'
  const bg = tokens['--dsw-alias-bg-base']
  if (bg === undefined) return undefined
  const ink = tokens['--dsw-alias-label-primary'] ?? (dark ? '#f5f5f7' : '#1d1d1f')
  const accent = tokens['--dsw-alias-brand-primary'] ?? (dark ? '#0a84ff' : '#007aff')
  const syntax = def.syntax ?? {}
  return {
    dark,
    bg,
    layer1: tokens['--dsw-alias-bg-layer-1'] ?? mix(bg, ink, dark ? 0.07 : 0.04),
    ink,
    inkSecondary: tokens['--dsw-alias-label-secondary'] ?? mix(ink, bg, 0.3),
    accent,
    syntax,
    ...stateSeeds(tokens, syntax, dark),
  }
}

/**
 * Every token a completed theme defines: the alias/specific set the base
 * sheets define (design-platform.css) minus the mask/login photo tokens that
 * stay at base, plus the four elevation shadows. `completeTheme` guarantees
 * exactly this key set; the tests hold every registry entry to it.
 */
export const COMPLETED_TOKENS: readonly string[] = Object.freeze([
  // Surfaces
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay', '--dsw-alias-bg-module-platform', '--dsw-alias-bg-multi-select', '--dsw-alias-bg-skeleton',
  // Labels
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-label-caption',
  '--dsw-alias-label-dimmed', '--dsw-alias-label-primary-dimmed', '--dsw-alias-label-primary-bluish',
  '--dsw-alias-label-primary-foreground', '--dsw-alias-label-primary-inverted',
  // Borders
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l2-darkmode-thin',
  '--dsw-alias-border-l3', '--dsw-alias-border-l4', '--dsw-alias-border-inverted', '--dsw-alias-border-inverted2',
  // Brand + mode line
  '--dsw-alias-brand-primary', '--dsw-alias-brand-primary-invert', '--dsw-alias-brand-primary-new-colorprimary-new-color',
  '--dsw-alias-brand-text', '--dsw-alias-mode-line-active',
  // Buttons
  '--dsw-alias-button-contrast-fill', '--dsw-alias-button-elevated-fill', '--dsw-alias-button-floating-fill',
  '--dsw-alias-button-floating-hover', '--dsw-alias-button-ghost-active-border', '--dsw-alias-button-ghost-active-fill',
  '--dsw-alias-button-ghost-active-hover', '--dsw-alias-button-info-fill', '--dsw-alias-button-info-hover',
  '--dsw-alias-button-primary-dimmed', '--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-tool-bar-fill', '--dsw-alias-button-tool-bar-fill-invisible', '--dsw-alias-button-tool-bar-hover',
  // Interactive fills
  '--dsw-alias-interactive-bg-active', '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-hover-accent',
  '--dsw-alias-interactive-bg-hover-danger', '--dsw-alias-interactive-bg-hover-solid',
  // Markdown
  '--dsw-alias-markdown-citation', '--dsw-alias-markdown-code-block', '--dsw-alias-markdown-code-block-banner',
  '--dsw-alias-markdown-code-segment-selected', '--dsw-alias-markdown-code-segment-unselected',
  '--dsw-alias-markdown-inline-code', '--dsw-alias-markdown-placeholder', '--dsw-alias-markdown-tag',
  // Scrollbars
  '--dsw-alias-scrollbar-bg-l1', '--dsw-alias-scrollbar-bg-l2', '--dsw-alias-scrollbar-hover-l1', '--dsw-alias-scrollbar-hover-l2',
  // State
  '--dsw-alias-state-business-primary', '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-error-secondary',
  '--dsw-alias-state-success-primary', '--dsw-alias-state-success-secondary', '--dsw-alias-state-success-tertiary',
  '--dsw-alias-state-warn-label', '--dsw-alias-state-warn-primary', '--dsw-alias-state-warn-secondary', '--dsw-alias-state-warn-tertiary',
  // Chrome
  '--dsw-alias-toast-bg', '--dsw-alias-tooltip-bg',
  // Chat specifics
  '--dsw-specific-bubble', '--dsw-specific-bubble-highlight', '--dsw-specific-input-major', '--dsw-specific-menu',
  '--dsw-specific-selector', '--dsw-specific-sidebar-fill', '--dsw-specific-sidebar-nav-item-active',
  '--dsw-specific-sidebar-nav-item-active-accent', '--dsw-specific-sidebar-nav-item-hover', '--dsw-specific-tip',
  // Elevation
  '--dsw-shadow-lv1', '--dsw-shadow-lv1-blur', '--dsw-shadow-lv2', '--dsw-shadow-lv3',
])

/**
 * Derive every token the definition leaves absent from its own anchors; hand
 * tokens always win. `anton-dark` (and any definition without anchors)
 * passes through untouched — it is the base palette itself.
 * @param def - the hand-tuned theme definition.
 * @returns a new definition whose token map covers {@link COMPLETED_TOKENS}.
 */
export function completeTheme(def: ThemeDefinition): ThemeDefinition {
  const a = anchorsOf(def)
  if (a === undefined) return def
  const derived: Record<string, TokenValue> = {}
  const set = (name: string, value: TokenValue): void => {
    if (def.tokens[name] === undefined) derived[name] = value
  }
  const dark = a.dark
  const bg = a.bg
  const ink = a.ink
  const accent = a.accent

  // Surface ladder: ink blended over the background at the opencode alpha
  // steps (0.04→0.14); the hand layer-1 stays the raised reference.
  const layer1 = a.layer1
  const layer2 = mix(bg, ink, dark ? 0.1 : 0.06)
  const layer3 = mix(bg, ink, dark ? 0.14 : 0.085)
  set('--dsw-alias-bg-layer-1', layer1)
  set('--dsw-alias-bg-layer-2', layer2)
  set('--dsw-alias-bg-layer-3', layer3)
  set('--dsw-alias-bg-overlay', layer2)
  set('--dsw-alias-bg-module-platform', mix(bg, ink, dark ? 0.12 : 0.07))
  set('--dsw-alias-bg-multi-select', layer3)
  set('--dsw-alias-bg-skeleton', alphaOf(ink, dark ? 0.07 : 0.05))

  // Label ladder: the hand ink, then mixes toward the background.
  set('--dsw-alias-label-primary', ink)
  set('--dsw-alias-label-secondary', a.inkSecondary)
  set('--dsw-alias-label-tertiary', mix(ink, bg, dark ? 0.45 : 0.42))
  set('--dsw-alias-label-caption', mix(ink, bg, dark ? 0.58 : 0.55))
  set('--dsw-alias-label-dimmed', mix(ink, bg, dark ? 0.5 : 0.35))
  set('--dsw-alias-label-primary-dimmed', mix(ink, bg, dark ? 0.22 : 0.12))
  set('--dsw-alias-label-primary-bluish', readableBand(mix(ink, accent, 0.3), dark))
  set('--dsw-alias-label-primary-foreground', onColor(accent))
  set('--dsw-alias-label-primary-inverted', dark ? mix(bg, ink, 0.12) : layer1)

  // Borders: ink-alpha ladder (opencode borderTone).
  set('--dsw-alias-border-l1', alphaOf(ink, dark ? 0.08 : 0.07))
  set('--dsw-alias-border-l2', alphaOf(ink, dark ? 0.13 : 0.11))
  set('--dsw-alias-border-l2-darkmode-thin', alphaOf(ink, dark ? 0.06 : 0.1))
  set('--dsw-alias-border-l3', alphaOf(ink, dark ? 0.18 : 0.15))
  set('--dsw-alias-border-l4', alphaOf(ink, dark ? 0.24 : 0.2))
  set('--dsw-alias-border-inverted', alphaOf(dark ? '#000000' : '#ffffff', dark ? 0.06 : 0))
  set('--dsw-alias-border-inverted2', alphaOf(dark ? '#ffffff' : '#000000', 0.08))

  // Brand: the accent stays; its inversions and hovers derive from it.
  set('--dsw-alias-brand-primary', accent)
  set('--dsw-alias-brand-primary-invert', onColor(accent))
  set('--dsw-alias-brand-primary-new-colorprimary-new-color', readableBand(accent, dark))
  set('--dsw-alias-brand-text', ink)
  const modeLine = def.tokens['--dsw-alias-mode-line-active'] ?? readableBand(accent, dark)
  set('--dsw-alias-mode-line-active', modeLine)

  // Buttons: accent fills with contrast-picked labels, ink-alpha ghosts.
  set('--dsw-alias-button-contrast-fill', mix(ink, bg, 0.15))
  set('--dsw-alias-button-elevated-fill', layer1)
  set('--dsw-alias-button-floating-fill', layer2)
  set('--dsw-alias-button-floating-hover', layer3)
  set('--dsw-alias-button-ghost-active-border', mix(ink, bg, 0.45))
  set('--dsw-alias-button-ghost-active-fill', mix(bg, ink, 0.12))
  set('--dsw-alias-button-ghost-active-hover', mix(bg, ink, 0.18))
  const infoFill = readableBand(accent, dark)
  set('--dsw-alias-button-info-fill', infoFill)
  set('--dsw-alias-button-info-hover', shift(infoFill, { l: dark ? 0.05 : -0.06 }))
  set('--dsw-alias-button-primary-dimmed', mix(accent, bg, dark ? 0.55 : 0.7))
  set('--dsw-alias-button-primary-fill', accent)
  set('--dsw-alias-button-primary-hover', shift(accent, { l: dark ? 0.07 : -0.07, c: 1.06 }))
  set('--dsw-alias-button-tool-bar-fill', alphaOf(ink, 0.5))
  set('--dsw-alias-button-tool-bar-fill-invisible', alphaOf(ink, 0.36))
  set('--dsw-alias-button-tool-bar-hover', alphaOf(ink, 0.6))

  // Interactive fills: ink alphas, accent-tinted selection, danger tint.
  set('--dsw-alias-interactive-bg-active', alphaOf(ink, dark ? 0.11 : 0.09))
  set('--dsw-alias-interactive-bg-hover', alphaOf(ink, dark ? 0.07 : 0.05))
  set('--dsw-alias-interactive-bg-hover-accent', alphaOf(accent, dark ? 0.2 : 0.12))
  set('--dsw-alias-interactive-bg-hover-danger', alphaOf(a.error, dark ? 0.15 : 0.08))
  set('--dsw-alias-interactive-bg-hover-solid', layer3)

  // Markdown: raised code surfaces over the theme bg, accent-tinted chips.
  // A near-white background has no lighter step left — tint toward the ink.
  const bgOklch = hexToOklch(bg)
  const codeBlock = dark
    ? mix(bg, ink, 0.16)
    : bgOklch.l >= 0.93 ? mix(bg, ink, 0.05) : mix(bg, '#ffffff', 0.45)
  set('--dsw-alias-markdown-code-block', codeBlock)
  set('--dsw-alias-markdown-code-block-banner', codeBlock)
  set('--dsw-alias-markdown-code-segment-selected', dark ? mix(bg, ink, 0.24) : '#ffffff')
  set('--dsw-alias-markdown-code-segment-unselected', dark ? mix(bg, ink, 0.1) : mix(bg, '#ffffff', 0.2))
  set('--dsw-alias-markdown-inline-code', dark ? mix(bg, ink, 0.2) : mix(bg, ink, 0.07))
  set('--dsw-alias-markdown-citation', dark ? mix(bg, ink, 0.18) : mix(bg, ink, 0.05))
  set('--dsw-alias-markdown-tag', dark ? mix(bg, ink, 0.18) : mix(bg, ink, 0.06))
  set('--dsw-alias-markdown-placeholder', mix(bg, ink, dark ? 0.22 : 0.09))

  // Scrollbars: the ink at the macos exemplar alphas.
  set('--dsw-alias-scrollbar-bg-l1', alphaOf(ink, dark ? 0.25 : 0.22))
  set('--dsw-alias-scrollbar-bg-l2', alphaOf(ink, dark ? 0.32 : 0.28))
  set('--dsw-alias-scrollbar-hover-l1', alphaOf(ink, dark ? 0.4 : 0.36))
  set('--dsw-alias-scrollbar-hover-l2', alphaOf(ink, dark ? 0.46 : 0.42))

  // State: hand-or-syntax seeds band-adjusted for the scheme, translucent tints.
  const error = readableBand(a.error, dark)
  const warn = readableBand(a.warn, dark)
  const success = readableBand(a.success, dark)
  set('--dsw-alias-state-error-primary', error)
  set('--dsw-alias-state-error-secondary', dark ? error : shift(error, { l: 0.08 }))
  set('--dsw-alias-state-success-primary', success)
  set('--dsw-alias-state-success-secondary', dark ? success : shift(success, { l: 0.08 }))
  set('--dsw-alias-state-success-tertiary', alphaOf(success, dark ? 0.16 : 0.12))
  set('--dsw-alias-state-warn-primary', warn)
  set('--dsw-alias-state-warn-secondary', dark ? warn : shift(warn, { l: 0.06 }))
  set('--dsw-alias-state-warn-label', shift(warn, dark ? { l: 0.02 } : { l: -0.1 }))
  set('--dsw-alias-state-warn-tertiary', alphaOf(warn, dark ? 0.16 : 0.12))
  const business = readableBand(accent, dark)
  set('--dsw-alias-state-business-primary', business)
  set('--dsw-alias-state-business-tertiary', alphaOf(accent, dark ? 0.16 : 0.1))

  // Chrome: tooltips/toasts read as a dark plate in both schemes.
  const plate = dark ? mix(bg, ink, 0.3) : mix(ink, '#000000', 0.25)
  set('--dsw-alias-tooltip-bg', alphaOf(plate, 0.95))
  set('--dsw-alias-toast-bg', plate)

  // Chat specifics: accent-tinted bubbles, ink-alpha selection fills.
  const bubbleTint = dark ? 0.16 : 0.09
  set('--dsw-specific-bubble', mix(layer1, accent, bubbleTint))
  set('--dsw-specific-bubble-highlight', mix(layer1, accent, bubbleTint * 1.9))
  set('--dsw-specific-input-major', layer1)
  set('--dsw-specific-menu', layer3)
  set('--dsw-specific-selector', mix(bg, ink, dark ? 0.12 : 0.06))
  set('--dsw-specific-sidebar-fill', def.tokens['--dsw-specific-sidebar-fill'] ?? layer1)
  set('--dsw-specific-sidebar-nav-item-active', mix(bg, ink, dark ? 0.2 : 0.08))
  set('--dsw-specific-sidebar-nav-item-active-accent', alphaOf(accent, dark ? 0.22 : 0.14))
  set('--dsw-specific-sidebar-nav-item-hover', mix(bg, ink, dark ? 0.12 : 0.06))
  set('--dsw-specific-tip', mix(bg, ink, dark ? 0.12 : 0.06))

  // Elevation: the macos exemplar's neutral formulas, heavier in dark.
  set('--dsw-shadow-lv1', dark
    ? '0 1px 3px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.3)'
    : '0 1px 3px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.05)')
  set('--dsw-shadow-lv1-blur', dark
    ? '0 4px 16px rgba(0, 0, 0, 0.35)'
    : '0 4px 16px rgba(0, 0, 0, 0.05)')
  set('--dsw-shadow-lv2', dark
    ? '0 2px 8px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.45)'
    : '0 2px 8px rgba(0, 0, 0, 0.06), 0 8px 24px rgba(0, 0, 0, 0.09)')
  set('--dsw-shadow-lv3', dark
    ? '0 0 1px rgba(0, 0, 0, 0.5), 0 16px 48px rgba(0, 0, 0, 0.55)'
    : '0 0 1px rgba(0, 0, 0, 0.12), 0 16px 48px rgba(0, 0, 0, 0.16)')

  // Guarantee the full set: any gap means the derivation table above is
  // missing an entry — fail the registry build instead of shipping a leaky
  // palette that silently falls back to the base sheet. Unreachable through
  // registry data; it guards future edits that add a COMPLETED_TOKENS entry
  // without a derivation row.
  for (const name of COMPLETED_TOKENS) {
    if (def.tokens[name] === undefined && derived[name] === undefined) {
      /* v8 ignore next */
      throw new Error(`completeTheme: "${def.id}" left "${name}" undominated`)
    }
  }
  return { ...def, tokens: { ...derived, ...def.tokens } }
}
