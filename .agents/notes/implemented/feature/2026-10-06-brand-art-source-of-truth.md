# Agent Note: Brand art source of truth

Status: implemented

## Problem

The harness web UI rendered the previous dark matrix-face mark while the product's brand art moved on: `apps/anton-bridge/macos/AppIcon.png` (the watercolor mask) already builds the macOS dock icon, so the header wordmark tile, the collapsed-rail mark, the welcome-hero logo, the favicon, and the PWA icon showed stale art.

## Decision

`apps/anton-bridge/macos/AppIcon.png` is the brand-art source of truth. The three web assets are mechanical derivations of it, regenerated at their existing declared dimensions whenever the art changes (this change):

- `apps/web/public/anton-mark.png` — 540×540 (favicon, wordmark tile, rail mark, hero logo)
- `apps/web/public/anton-mark@2x.png` — 1080×1080
- `apps/web/public/anton.png` — 1024×1024 (PWA manifest `sizes: 1024x1024`)

No component changed: `BrandWordmark` and `FishLogo` already render `/anton-mark.png`, and the favicon link and manifest already point at these paths. The rounded-chip treatment (26–28% corner radius) stays; the new art's cream plate reads as the chip in both themes.

## Consequences

A future art change means replacing `AppIcon.png` and re-running the three `sips` derivations — no code edits. The components' names (`FishLogo`) are historical; they render the Anton mark image.

## Testing

Pixel content is not asserted anywhere: the sidebar DOM snapshots and icon specs pin `src` paths and element structure only, and `pwa-manifest` e2e asserts the favicon exists behind the manifest/link declarations.
