# Blueant capture tier — selected text, screenshot, on-demand clipboard (Phase 4b)

2026-09-20 — antoncode workspace, Anton macOS app.

## What changed

- `DesktopContext.snapshot(prompt:)` (HarnessClient.swift) gained three
  capture sources, all appended to the same `<desktop-context>` prefix and
  the same "Read:" provenance header shipped in
  2026-09-20-blueant-answer-provenance.md:
  - **Selected text**: `kAXFocusedUIElementAttribute` →
    `kAXSelectedTextAttribute` on the frontmost app, truncated at 500
    chars in the prompt. Trust failures (`apiDisabled`,
    `cannotComplete`) set `accessibilityDisabled` like the title probe;
    a missing selection is expected and silent — an app without a
    selection must not kill the probe for trusted apps later.
  - **Screenshot**: the frontmost window via ScreenCaptureKit
    (`SCShareableContent` → `SCContentFilter(desktopIndependentWindow:)`
    → `SCScreenshotManager.captureImage`), saved as PNG under
    `~/Library/Application Support/Anton/blueant/attachments/ask-*.png`.
    The context line carries the path and instructs the model to read it
    with the `read_image` tool — no attachment wire protocol needed.
  - **Clipboard**: strictly on demand — attached only when the prompt
    mentions "clipboard"/"copied"/"copy ". Never ambient.
- The Blueant preset's tool roster (`apps/anton-bridge/src/blueant-preset.ts`
  and the deployed `~/.agent-presets/blueant/agent.cordis.yml`) now allows
  `read_image` so the screenshot path is consumable. The preset file is
  existsSync-guarded, so the deployed copy was edited in place; the guard
  means future template changes will not clobber it.

## Decisions and their reasons

- **The macOS permission dialogs are the approve-once gates.** Screen
  Recording is preflighted (`CGPreflightScreenCaptureAccess`) and requested
  at most once per process lifetime (`CGRequestScreenCaptureAccess`); a
  denial means screenshots silently never appear — no nagging, no
  custom approval UI. Accessibility trust was already granted for the
  window title; selected text rides it.
- **Screenshot path-in-context instead of a session attachment API.** The
  harness has no attachment upload on the popup ask path; a workspace file
  path plus `read_image` reaches the model through the existing tool
  surface and is reconstructable from the session log.
- **Screenshot on every ask, not behind a button.** Arivu reads "tab text
  and a screenshot" per question; capture is read-only and provenance-
  disclosed, so it stays inside the Ask tier by construction.
- **`CGWindowListCreateImage` is obsoleted (macOS 15 SDK)**; the capture
  goes through ScreenCaptureKit with a semaphore park (one frame) because
  `SCScreenshotManager` is async and the ask path is synchronous.

## Failures met on the way

- Void-returning `CGImageDestinationAddImage` cannot sit in a `guard`
  condition chain; split into statements.
- Missing `import ScreenCaptureKit` surfaced as scope errors, not import
  errors — the framework link alone is not enough for Swift name lookup.

## What this unblocks

- Phase 5a journal collector reuses `DesktopContext.snapshot` output as the
  per-tick journal entry; the attachments folder is the screenshot store.
- Phase 4c act tier adds the write-side counterpart (notify + gated shell).
