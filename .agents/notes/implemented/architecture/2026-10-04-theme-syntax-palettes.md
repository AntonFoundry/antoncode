# Agent Note: Syntax-highlight palettes are theme-scoped, not global constants

Status: implemented

## Problem

`ui-theme/src/styles/shiki.css` pinned the `--shiki-token-*` colors to one fixed light pair plus one fixed dark pair. Every surface aliased the active theme for backgrounds (`--shiki-background: var(--dsw-alias-markdown-code-block)`) and foreground, but the nine token hues were constants: the Aqua pair, the doom library, gruvbox, and tokyo-night all rendered the same pink keywords and gray comments. With `load-theme` shipping dozens of distinct palettes, the code surfaces were the one visible layer that ignored the theme.

## Decision

**A theme owns its syntax hues like any other token layer.** `ThemeDefinition` gains an optional `syntax` palette (the nine `--shiki-token-*` variable names; foreground/background stay aliased). `ThemePresenter.apply` projects `active.syntax` through the same inline-variable channel it already uses for alias tokens — inline variables override the stylesheet while the theme is active, and the existing retraction set removes them on switch and dispose, so a theme without a palette falls back to the shiki.css default pair with no code change. Zero JS joins the render path: consumers keep reading `--shiki-*` custom properties.

Palettes are authored where each theme already lives. The eleven curated palettes in `ui-layout/themes.ts` carry hand-authored `syntax` consts (canonical hues for Xcode light/dark, nord, gruvbox, monokai-pro, doom-one, dracula, tokyo-night, paper, sepia, midnight; `anton-dark` intentionally omits one and exercises the default path). The doom library keeps its generated-file discipline: `doomTheme()` gains an optional `syntax` argument extracted from the same `.el` sources as the token palettes — the face categories (keywords/functions/strings/constants/variables/operators/comments/type) map onto the token roles, with `if`/`doom-lighten` forms resolved to their resolvable color symbol. 58 of the ported themes carry extracted palettes; the rest (fewer than eight resolvable roles) omit one and inherit the defaults.

## Alternatives considered

**Theme-scoped CSS sheets keyed on `body[data-ds-theme]`** (one static block per theme in a stylesheet). Rejected: the shipped themes live as data in `ui-layout` (including 58 generated doom palettes), so the values would need a second generated home and every third-party theme registration would ship no palette until a stylesheet edit landed. The inline-variable channel the presenter already owns projects registration data with no second home.

**Compute token colors from the theme background at runtime** (hue-mapping the base ramp into nine roles). Rejected: fabricated hues drift from each theme's authored intent, and the doom library already carries canonical syntax colors in its `.el` sources — extraction preserves them exactly.

## Consequences

- Switching themes now recolors code: markdown fences, chat code blocks, the read card, and the file viewer all read the projected variables.
- The shiki.css default pair stays authoritative for themes without `syntax` — adding a theme needs no palette work to ship.
- Regenerating the doom palettes must re-derive the `syntax` argument together with the token palette, or the two layers drift; the file header says so.

## Related

- [Web syntax highlighting (shiki)](../process/2026-07-26-web-syntax-highlighting-shiki.md) — owns the shiki singleton, the grammar allowlist, and the `--shiki-*` sheet this note refines per theme. Partial supersession: the palette VALUES are no longer one fixed light/dark pair; the sheet, engine, and lazy-grammar decisions stand.
