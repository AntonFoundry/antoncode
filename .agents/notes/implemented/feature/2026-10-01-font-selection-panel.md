# Agent Note: Font selection panel in Settings General

Status: implemented

## Problem

The harness GUI had no way to change fonts: the monospace stack was a fixed literal in `base.css` (`SF Mono` first) and every code surface sized itself in hardcoded px. The user-facing ask was a font panel controlling the look and feel, with Monaco 15 as the default monospace.

## Decision

Monospace font selection (family + size) is a second settings row owned by ui-theme, riding the same durable `ui-theme` settings namespace as the theme preference and the same pre-paint bootstrap. The settings document gained `monoFont` (curated id, default `monaco`) and `monoSize` (px, 10–24 inclusive, default 15). `FontRuntime` (provided as `ctx.font`, event `font/change`) owns the live selection and applies it itself as two CSS custom properties on the document root: `--ds-font-family-code` (already the code stack token) and the new `--dsw-font-size-code`. The boot index transform writes both properties inside the existing synchronous bootstrap script, so a persisted selection renders before first paint with no flash. `CodeBlock`/`JsonBlock`/`MarkdownText pre` size from `--dsw-font-size-code` (previous px as fallback), and the xterm `TerminalView` reads the token once at mount for its initial `fontSize`.

## Mechanics

`MONO_FONTS` (Monaco, JetBrains Mono, SF Mono, Menlo, Fira Code, Cascadia Code, Consolas) validates at the settings boundary — a schema union of ids plus a numeric size range — so the stored document cannot hold an arbitrary `font-family` string. Every stack keeps a CJK tail, matching the base.css policy against SimSun fallback. The Font row (family menu + size stepper + live preview) registers beside the Appearance row in `settings.general.item` and writes through `setMonoFont`/`setMonoSize`; the store mirrors `font/change` snapshots with the same revision-guard pattern the Appearance row uses.

## Alternatives considered

**A new plugin/package.** The panel is presentation detail of the existing settings surface; ui-theme already owns the Appearance row, the namespace, and the index bootstrap — the smallest existing extension point that reaches the surface.

**Routing DOM application through ui-layout's presenter, like ThemeRuntime.** ThemeRuntime's contract routes palette tokens through the presenter because every consumer re-reads tokens; the two font properties are typography facts this feature owns end-to-end, and splitting application to ui-layout would add a cross-plugin dependency for two style writes.

**Free-form family strings.** Rejected: unvalidated CSS in the durable settings document; curated ids keep the boundary checkable.

## Consequences

UI (proportional) family/size selection is deferred — the request that drove this was the monospace stack. Live xterm re-fit on `font/change` is deferred: the terminal samples the size at mount and keeps its Nerd Font family stack for icon glyphs.

## Verification

`font-runtime.client.spec.ts` (defaults, curated/range validation, scope adoption, DOM property writes), `font-store.client.spec.ts` (revision guard), `font-row.client.spec.tsx` (preview, family menu, stepper clamping), extended `boot-theme.client.spec.ts` (pre-paint vars, defaults) and `host.client.spec.ts` (schema defaults, range rejection, boot embedding). Handoff note: `packages/host/apiproxy/tests/api-proxy-config.spec.ts` has 6 pre-existing failures on a clean tree, unrelated to this change.
