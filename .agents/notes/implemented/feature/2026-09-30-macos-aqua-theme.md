# Agent Note: macOS Aqua theme pair and the Aqua default experience

Status: implemented

## Problem

The web GUI's curated themes were near-identical recolors of the base palettes, and the boot default exposed those bases directly — no theme carried a native-platform design, so on macOS the app looked like a generic web panel. The user-facing ask was explicit: the harness should feel like macOS X, icons included. Making a palette the *default* experience also had to coexist with the two persistence channels that already exist: the theme service's durable built-in preference (light/dark/system in user-settings) and ui-layout's localStorage `load-theme` choice.

## Decision

The harness GUI ships a macOS X look through the existing theme system: two curated palettes in the compos registry — `macos` (light) and `macos-dark` — carry the Apple light/dark-appearance materials (systemGray6 window base, white/gray5 raised cards, systemBlue `#007aff` / `#0a84ff` as the signature brand and mode-line accent, traffic-light state hues, alpha overlay scrollbars, soft large card shadows via the `--dsw-shadow-lv*` tokens), and a theme-owned refinement sheet (`ui-theme/src/styles/theme-macos.css`) adds what a custom property cannot express. The Aqua pair is also the default experience: boot restores the persisted `load-theme` choice when one exists, and otherwise applies `macos` or `macos-dark` following the OS appearance while the durable preference is still `system`, without persisting anything. An explicit Light/Dark selection in Settings → Appearance persists through the theme service and therefore suppresses the default on later boots; System returns to the Aqua default; an explicit `M-x load-theme` choice stays sticky in `dsh.layout.theme`.

## Mechanics

The presenter publishes the active theme id on `body[data-ds-theme]` next to the palette attribute; the refinement sheet keys every rule on it: rounded stroke terminals and joins on stroked SVG shapes (the SF Symbols feel across the shared icon set and every feature-local inline icon) and Aqua selection tints. Fill-only glyphs and per-icon stroke widths are untouched, so designed icon hierarchy survives, and the base palettes plus every other named theme match byte-for-byte. The palettes stay pure token override layers: no feature CSS changed, and the WmFrame chrome, minibuffer, settings surfaces, and scrollbars restyle through the tokens they already consume. The pre-activation window keeps the base palette (the host boot script knows only the built-in preference), then flips when the client tree activates — the same beat every named theme already had.

## Alternatives considered

**A new styling mechanism or per-component restyle.** Extending the shared theme layer is the documented ownership rule, and feature CSS must stay free of theme branches; a parallel mechanism would have forked the token scale for one look.

**Persisting any registered theme id through the theme service.** Host-side persistence for registered ids would mix the two persistence models and reshape the built-in Appearance schema and its cubes; the localStorage palette flow already gives named themes a sticky home, and the built-in cubes remain the deliberate escape hatch to the plain bases.

**Uniform icon stroke-width flattening.** One CSS width for every glyph would erase the emphasis some icons draw through heavier strokes; rounding terminals and joins gives the SF Symbols character without flattening hierarchy.

**Backdrop-filter vibrancy on overlays.** A global blur rule would reach into component layers that own their compositing; near-opaque tinted overlays approximate the material without coupling the theme to feature DOM.

## Consequences

The default boot now lands on a coherent native-platform look that follows the OS appearance, and future named themes inherit the `data-ds-theme` seam for their own refinement sheets. The costs: a theme-scoped global selector now exists and must stay keyed on presenter-published attributes only (never feature classes); the Aqua palettes override more tokens than the curated set (shadows, scrollbars, interactivity), so a token added to the base sheets should be checked against both macOS palettes; and the pre-activation beat still shows the base palette before the client tree activates.

## Testing

`pnpm run test:gui` covers the seam: `theme-presenter.client.spec` asserts the id attribute follows the active id and retracts on dispose, `apply.client.spec` asserts the Aqua default on a fresh system-preference boot and that a stored id wins, `themes.client.spec` pins the Aqua pair and the `--dsw-*` override-layer shape, and the web shell `base-styles.client.spec` proves every imported sheet exists. The client aggregate typecheck is clean. `host/apiproxy` `api-proxy-config.spec` was red on this tree before the change (settings baseURL assertion) — unrelated surface, left for its owning session.
