# Agent Note: Theme boot adoption blocked by the Aqua restore palette

Status: implemented

## Problem

After `page.reload()` (or a fresh page on a fresh host sharing the same home) the web app rendered light with the persisted dark preference still in `settings.yaml`; the client `settings.describe` returned `ui-theme.value = { preference: "dark" }`, yet no Appearance cube was pressed — not even 跟随系统, the default. The boot splash (server-side `boot-theme.ts` read) applied dark, so users saw a dark splash decay into a light app.

## Root cause

`SettingsScopeController.read()` is asynchronous: at boot, ui-layout's theme effect activated before the first section published and applied the Aqua fallback through `ctx.theme.setTheme("macos")` (`packages/client/ui-layout/src/client/index.ts`, "boots the Aqua default" branch). The adopt guard added in the [palette-adoption decision](2026-10-06-theme-palette-adoption-guard.md) ("never demote an active registered palette through scope adoption") then saw a non-builtin active preference (`macos`) and returned from every later `ThemeRuntime.adopt()` — the durable `dark` could never adopt for the whole session. A registered-id preference matches no Appearance cube, which is why zero cubes carried `aria-pressed`.

Reproduced outside the browser by booting the built `connection` + `ui-settings` + `ui-theme` bundles in jsdom against the live host's `settings.describe` payload: with the Aqua restore seeded via `setTheme`, adoption is dead; the scope/decode/describe paths themselves were proven correct (the real envelope and value rehydrate and validate cleanly).

## Decision

- `packages/client/ui-theme/src/client/index.ts`: split `setTheme` into `activate` (shared validation/publish) plus two entry points. `restoreBootDefault(id)` applies a palette as the presentation boot default — the one palette kind a durable light/dark section may replace. `adopt()` yields only when the active palette is a boot default and the section names an explicit light/dark choice; a durable `system` agrees with the boot default and keeps it. An explicit `setTheme` palette (load-theme, localStorage restore) stays fully protected, preserving the the [palette-adoption decision](2026-10-06-theme-palette-adoption-guard.md) contract.
- `packages/client/ui-layout/src/client/index.ts`: the Aqua fallback branch calls `restoreBootDefault` instead of `setTheme`.
- `packages/client/ui-settings/src/client/settings-mirror.ts`: the silent describe catch, rejected-result path, schema-envelope rehydration catch, and schema-validation failure now `console.error` with the namespace and reason (a silent dead read was exactly what made the boot divergence undiagnosable; recovery still rides the `connection/reset` retry).

## Verification

- New specs: `ThemeRuntime` boot-default yield/agreement/no-write-through; ui-layout boot race (Aqua restored, section publishes dark → presenter applies dark); settings-scope loud transport failure with recovery, loud rejected result, loud rehydrate failure.
- `pnpm vitest run packages/client/ui-theme packages/client/ui-settings packages/client/ui-layout`: 54 files / 717 tests green. `tsc -b tsconfig.client.json` clean for touched packages.

## Alternatives considered

**Protect every registered palette from adoption.** Rejected: the automatic Aqua boot default would prevent an explicit durable dark/light preference from loading. Explicit user palettes remain protected; only the boot default yields.

## Consequences

The boot palette yields to durable light/dark settings while explicit user palettes keep adoption protection. Failed settings reads report their namespace and reason and recover on connection reset.
