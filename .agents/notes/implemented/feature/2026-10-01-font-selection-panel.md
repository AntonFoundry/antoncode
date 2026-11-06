# Agent Note: Font selection panel in Settings General

Status: implemented

## Problem

The harness GUI had no way to change fonts: the monospace stack was a fixed literal in `base.css` and every code surface sized itself in hardcoded px. The GUI has several distinct font domains — interface chrome (sidebar, settings, headers), conversation text, monospace code surfaces (fenced blocks, bash/tool cards, JSON), and the xterm terminal — and a single mono knob could not express them. The user-facing ask was a font panel controlling the look and feel with Monaco 15 as the default monospace, followed by feedback that size changes must actually reach every surface each section claims.

## Decision

Font selection is a second settings surface owned by ui-theme, riding the same durable `ui-theme` namespace as the theme preference and the same pre-paint bootstrap. The settings document holds six fields across four sections: `uiFamily` + `uiSize` (Interface), `chatSize` (Chat), `monoFont` + `monoSize` (Code), and `termSize` (Terminal). `FontRuntime` (provided as `ctx.font`, event `font/change`) owns the live selection and applies it itself as six CSS custom properties on the document root: `--dsw-font-family`, `--dsh-zoom-ui`, `--dsh-zoom-chat`, `--ds-font-family-code`, `--dsw-font-size-code`, `--dsh-font-size-term`. The section unit model (px sizes with zoom as implementation, the enumerated system family menu, and the portaled-overlay zoom coverage) is owned by the superseding [font system v3 note](2026-08-12-font-system-v3-px-units-system-fonts.md); this note keeps the section architecture.

Size application follows the architecture rather than patching consumers:

- **Interface/Chat size through `zoom`.** Most UI text is fixed px (tokens plus literals), so per-token derivation cannot reach it. ui-layout's `.frame` carries `zoom: var(--dsh-zoom-ui)`; `.pane[data-buffer='session']` carries `zoom: var(--dsh-zoom-chat)`. The chat var holds the compensated ratio because zoom multiplies when nested — each section therefore stays independent.
- **Code size derives inside the font tokens.** The three mono shorthand tokens (`--dsw-font-markdown-code`, `-code-block`, `-code-block-small`) derive size and line-height from `--dsw-font-size-code`. This is the fix for the v1 failure: bash/tool cards consume `font: var(--dsl-terminal-font)` (the shorthand token), so per-consumer `font-size:` overrides never reached them while the family var did.
- **Terminal size reaches xterm twice:** the boot var seeds the initial `fontSize`, and ui-terminal mirrors `font/change` into a hooks-compartment store so mounted views set `term.options.fontSize` and re-fit through FitAddon live.

`MONO_FONTS` and `UI_FONTS` are curated id lists validated at the settings boundary (schema unions + numeric ranges), so the stored document cannot hold an arbitrary `font-family` string; every stack keeps a CJK tail, matching the base.css policy against SimSun fallback.

## Alternatives considered

**Per-consumer `font-size` overrides (v1).** Rejected by evidence: the shorthand tokens pin size inside `font:`; consumers that consume the shorthand never see the override. One home per fact — the token — replaces the scattered overrides.

**Deriving all UI font tokens from a scale var.** Rejected: hundreds of literal-px rules sit outside the token set; only zoom reaches everything uniformly.

**A new plugin/package.** The panel is presentation detail of the existing settings surface; ui-theme already owns the Appearance row, the namespace, and the index bootstrap.

**Routing DOM application through ui-layout's presenter, like ThemeRuntime.** The six font properties are typography facts this feature owns end-to-end; splitting application to ui-layout would add a cross-plugin dependency for style writes that ui-layout does not otherwise consume.

## Consequences

Portaled overlays follow the interface zoom since the v3 note (their portal roots carry the zoom var). The terminal keeps its Nerd Font family stack for icon glyphs and follows only `termSize`. Fractional sizes are refused (integer px), and the persisted document upgrades in place through schema defaults.

## Verification

`font-runtime.client.spec.ts` (defaults, per-field validation, zoom compensation, scope adoption, six DOM property writes), `font-store.client.spec.ts` (revision guard over the full selection), `font-row.client.spec.tsx` (four sections, per-section previews, menu and stepper wiring with clamping), `boot-theme.client.spec.ts` (pre-paint vars, defaults), `host.client.spec.ts` (schema defaults, range rejections, boot embedding), `apply.client.spec.ts`.
