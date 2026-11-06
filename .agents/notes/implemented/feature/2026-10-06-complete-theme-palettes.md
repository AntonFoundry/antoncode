# Agent Note: Complete theme palettes via OKLCH derivation from each theme's own anchors

Status: implemented

English

## Problem

Registered themes hand-tuned only their identity tokens — the background ramp, the label ladder, borders, the sidebar fill, and the brand accent (~12–25 tokens out of the ~90 the base sheets define). Every other surface fell through to the anton-dark/light base palette, so a loaded theme recolored the chrome while chat bubbles, the composer input, markdown code blocks, selectors, scrollbars, and state colors kept the base look. The result read as a background shuffle with mismatched, garish chat surfaces — the user's report — instead of a coherent palette.

antoncode-ui (opencode) avoids exactly this by deriving the complete token set at load time from ~10 seed colors in OKLCH space (`packages/ui/src/theme/resolve.ts` + `color.ts`): surfaces and borders are ink-alpha tones blended over the theme background, text ladders mix ink toward the background, `on()` picks the readable text color per fill, and syntax/markdown accents come from the palette seeds.

## Decision

`ui-layout/src/client/theme-derive.ts` ports the compact OKLCH engine (hex↔OKLCH with gamut-fit chroma compression, `shift`, `mix`, alpha strings, a luminance-based `onColor`) and a `completeTheme(definition)` that fills every base-sheet token the definition leaves absent (`COMPLETED_TOKENS` is the target set: the alias/specific tokens `design-platform.css` defines minus the mask/login photo tokens that stay at base, plus the four elevation shadows). Derivation happens once, at registry build time in `themes.ts`; the presenter path is unchanged — it still applies a flat token map as inline variables, so no runtime resolver ships.

Hand tokens are authoritative anchors and are never overwritten; derivation only fills gaps. Surfaces and borders derive from the theme's own background/ink (ink-alpha ladders per color scheme), chat bubbles and sidebar accents get the theme's signature hue at low mixes, and the error/warn/success seeds come from the theme's hand state tokens when present, else its `--shiki-*` syntax faces nearest the red/amber/green hue bands within a 15° OKLCH window with a 0.09 chroma floor, else the neutral shipped hue. The window and floor matter: OKLCH places magenta at ~350° next to red at ~29°, so a wide window seeded errors from pink keywords, and achromatic faces (white parameters, cream foregrounds) carry only atan2 rounding noise for a hue. `anton-dark` (empty tokens) passes through untouched — it IS the base palette. A completion that would leave a target token undominated throws at registry build, so adding a `COMPLETED_TOKENS` entry without a derivation row fails loudly instead of leaking base values.

Two numeric contracts worth recording: OKLCH→sRGB output is gamut-fit by chroma compression (reducing chroma preserves hue; naive channel clamping distorts it), and the linear-RGB pre-transfer values clamp to `[0,1]` before the sRGB transfer because at `l = 1` the LMS³ product lands at `1 + 2e-16` and the fractional transfer exponent turns the overshoot into NaN — pure white crashed the first derivation.

## Alternatives considered

**Port opencode's `resolve.ts` wholesale with its 12-step scales and runtime application.** The harness token layer is flatter (one alias per surface, no `neutralAlpha` ramp consumers), and deriving at registry build keeps the presenter contract unchanged; the compact port covers every consumed token without dead machinery.

**Hand-author complete palettes for all 76 themes.** 76 × ~89 values of hand-maintained color data invites exactly the drift this defect class feeds on; anchors + derivation keep each theme's identity in its hand tokens and the rest mechanical.

**Ship per-theme CSS refinement sheets under `body[data-ds-theme]`.** New surface per theme, a second mechanism beside the existing token application, and no help for the doom library; the token layer already reaches every surface the user flagged.

## Consequences

Theme authors maintain identity anchors rather than a complete token table. Generated values never override those anchors, and adding an uncovered target token fails registry construction. The compact color conversion remains maintained locally, including gamut-fit and floating-point edge cases.
