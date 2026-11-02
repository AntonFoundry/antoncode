# Agent Note: Browser acting-as-user — agent-owned Chrome profile, trusted page actions

Status: implemented

English

## Problem

The highest-value agent actions live inside web pages: applications, portals,
form submissions. A page fetcher issues one HTTP request and returns markup;
it cannot run JavaScript, hold a session, or click a control. The agent needs
a browser a person could use — and the user needs to be able to watch it.

## Decision

- **Isolation.** `apps/anton-bridge/src/chrome.ts` launches the installed
  Chrome with
  `--user-data-dir=<app support>/Anton/anton-chrome --remote-debugging-port=0`
  (ephemeral loopback port discovered through `DevToolsActivePort`). The
  profile is separate from daily browsing, so no personal cookies or tabs are
  reachable, and the window is visible and grabbable at any moment.
  `ensureRunning` attaches to an already-running agent Chrome first (probe
  `/json/version`) and spawns only when nothing answers, so a window survives
  a bridge restart and a second instance never triggers the singleton
  handoff.
- **Tools.** `apps/anton-bridge/src/desktop-tools.ts` registers
  `browser_open`, `browser_read`, `browser_fill`, and `browser_click` in every
  session of the web profile, over `/bridge/api/chrome/*`. `browser_read`
  returns the rendered text (≤12 000 chars), the URL, a form outline with
  usable CSS selectors, and the visible buttons (≤40 fields, ≤20 buttons,
  password values masked).
- **Execution trust.** Fills and clicks go through
  `Input.dispatchMouseEvent` and `Input.insertText`, not DOM mutation, so site
  handlers and validation run. Each fill is re-read from the page and reported
  with what the field actually holds, so an autocomplete widget that ignores
  `insertText` surfaces as a mismatch instead of a silent success.
- **One policy.** There is no bridge-side approval ledger or proposal card:
  the harness tool permission policy governs the calls, exactly as it
  governs `bash` (see [Desktop actions use the harness tool permission
  policy](../bug-fix/2026-09-27-desktop-tool-permission-policy.md)).
- **Mounting.** The bridge copies the plugin into the web profile and appends
  one managed `insert` row to that profile's patch, so the driver is part of
  the ordinary agent composition rather than a separate persona.

## Testing

`apps/anton-bridge/tests/desktop-tools.spec.ts` covers registration, the
bridge calls each tool makes, the form outline it hands the model, the
page-title echo on a fill, and the unreachable-app message. The driver itself
is verified by a CDP round trip against a synthetic form: open → read → trusted
fill (value verified) → trusted click (the page's own submit handler ran). The
macOS build's boot smoke composes the real profile with the plugin mounted.

## Alternatives considered

AppleScript `execute javascript` and accessibility-tree clicks were rejected
in the design record: they depend on per-app scripting grants and miss
JavaScript-rendered content. A Chrome extension plus native messaging host
remains the long-term upgrade behind the same tool names; it would replace the
CDP transport without changing the model-facing contract. `WKWebView` was
rejected for this purpose because the page would live inside Anton's window
rather than in a browser the user can grab, with no persistent profile.

## Consequences

The user signs into target sites once inside the agent window — the deliberate
trade for never granting the agent the personal profile. The window is
interruptible at any time; closing it costs one relaunch on the next call.
Selectors are CSS only, and there is no keyboard control, tab management,
upload, or screenshot support. Page text is capped, so a huge page is read
partially by design.
