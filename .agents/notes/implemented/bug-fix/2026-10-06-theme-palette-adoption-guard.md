# Agent Note: ThemeRuntime adoption never demotes an active registered palette

Status: implemented

English

## Problem

A theme chosen through `M-x load-theme` reverted on the next reload, and the stored choice disappeared. The load-theme path itself was correct — ui-layout's `loadTheme` face writes the palette id to `dsh.layout.theme` and the boot effect restores it — but the restore did not survive the boot sequence: `bindSettingsScope` installs its subscription before its nonblocking initial read, so the loaded `ui-theme` section (whose `preference` field still holds the last built-in, `system` by default) published a snapshot right after the palette became active. `ThemeRuntime.adopt()` compared that section against the live preference and overwrote the palette id with the stored built-in. ui-layout's `theme/change` listener then saw a built-in preference and deleted the localStorage key, so every reload repeated the cycle. Because the theme and font fields share one `ui-theme` section, the same adoption also killed a live palette whenever any font setting changed.

The ui-layout comment describing the wipe-on-built-in rule already assumed "the adopt() guard in ui-theme" prevented built-in publishes while a palette is active; no such guard existed. The suites missed the path because `stubSettingsScope` stays in its `loading` state unless a test publishes a section, so the adoption after restore never ran under test.

## Decision

`ThemeRuntime.adopt()` returns while the live preference is not one of the three built-ins. The durable scope models only `light`/`dark`/`system`; a registered palette is an explicit load-theme choice that rides over the stored built-in until something releases it — an explicit built-in selection (which ui-layout's listener uses to clear the stored id) or the palette's registration disposer. This matches the documented model that third-party theme ids do not cross the built-in settings schema ([Host-backed preferences decision](2026-08-06-host-backed-web-preferences.md)).

## Alternatives considered

**Stop deleting the stored key in ui-layout's listener.** That would keep a stale palette id across an explicit Light/Dark/System choice, resurrecting the palette on the next boot — the opposite of the wipe rule's intent. The listener is correct once no spurious built-in publish reaches it.

**Persist palette ids through the Host settings schema.** The schema deliberately carries only the three built-in preferences; palette registries are per-composition client state, and widening the wire contract for a localStorage key would couple the Host document to client-side registrations.

## Partial supersession (2026-10-12)

The unqualified guard blocked legitimate boot adoption: ui-layout's Aqua fallback applied a registered id through `setTheme` before the first section published, and the durable dark/light choice then could never adopt (splash dark, app light, no cube pressed). The refinement introduces `ThemeRuntime.restoreBootDefault` — the one palette kind a durable light/dark section may replace; an explicit `setTheme` palette keeps the protection this note decided. See [theme boot adoption vs the Aqua default](2026-10-12-theme-boot-adoption-vs-aqua-default.md).
