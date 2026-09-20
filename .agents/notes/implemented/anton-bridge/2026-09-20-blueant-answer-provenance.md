# Blueant answer provenance + window-title context (Phase 4a/4d slice)

2026-09-20 — antoncode workspace, Blueant popup panel.

## What changed

- `DesktopContext` (HarnessClient.swift) now returns a `Snapshot` with two
  faces: the `<desktop-context>` prompt prefix (unchanged contract, one new
  line) and a user-facing `provenance` string. New signal: the focused
  window title, read through the Accessibility API
  (`kAXFocusedWindowAttribute` → `kAXTitleAttribute`).
- `BlueantPanel.ask` captures the snapshot at ask time; when the answer
  arrives, the answer area renders a `Read: <app> — “<title>” — <url>`
  header (tertiary, 11px) above the streamed text — Arivu's provenance
  header, the "what was read" transparency surface.

## Decisions and their reasons

- **Self-disabling probes, never prompt storms.** The window-title probe
  sets `accessibilityDisabled` on first failure (untrusted process or app
  refusal), exactly like the existing browser-URL AppleScript probe.
  Provenance degrades to app-name-only; the ask never blocks on a consent
  dialog.
- **Provenance shown only with an answer.** The header attributes an
  answer; during streaming status ("…") it would read as noise.
- **Truncation is display-only.** The model gets the full title line; only
  the keybar-side provenance string is capped at 60 chars.

## Failures met on the way

- First attempt used a `String` extension init and called it from string
  interpolation (`\(title, maxCount:)`) — interpolation needs
  `appendInterpolation` overloads, not extensions; replaced with a private
  static `truncate` on `DesktopContext`.

## What this unblocks

- Realized the same day: the capture tier (selection, screenshot,
  on-demand clipboard) appends to this snapshot — see
  2026-09-20-blueant-capture-tier.md.
