# Agent Note: Brand art source of truth

Status: implemented

## Problem

The harness web UI rendered the previous dark matrix-face mark while the product's brand art moved on: `apps/anton-bridge/macos/AppIcon.png` (the watercolor mask) already builds the macOS dock icon, so the header wordmark tile, the collapsed-rail mark, the welcome-hero logo, the favicon, and the PWA icon showed stale art.

## Decision

`apps/anton-bridge/macos/AppIcon.png` is the brand-art source of truth for the
dock icon and the header wordmark. The header tile is a mechanical derivation
of it, regenerated at its existing declared dimension whenever the art changes:

- `apps/web/public/anton-header.png` — 540×540 (header wordmark tile in the
  app frame brand row and the sidebar brand button, via `BrandWordmark`)

Deliberately NOT derived: the in-chat mark stays pinned to the previous art —
`apps/web/public/anton-mark.png` (540×540; favicon, rail mark, hero logo via
`FishLogo`), `apps/web/public/anton-mark@2x.png` (1080×1080), and
`apps/web/public/anton.png` (1024×1024 PWA manifest icon) are not regenerated
on art changes.

No component changed: `BrandWordmark` and `FishLogo` already render `/anton-mark.png`, and the favicon link and manifest already point at these paths. The rounded-chip treatment (26–28% corner radius) stays; the new art's cream plate reads as the chip in both themes.

## Consequences

A future art change means replacing `AppIcon.png` and re-running the three `sips` derivations — no code edits. The components' names (`FishLogo`) are historical; they render the Anton mark image.

## Testing

Pixel content is not asserted anywhere: the sidebar DOM snapshots and icon specs pin `src` paths and element structure only, and `pwa-manifest` e2e asserts the favicon exists behind the manifest/link declarations.
