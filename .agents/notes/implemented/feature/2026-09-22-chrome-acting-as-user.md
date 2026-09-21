# Agent Note: Chrome acting-as-user — agent-owned profile, approve-gated page actions

Status: implemented

English

## Problem

The Act tier ran shell commands behind human approval, but the highest-value
agent actions live inside web pages: applications, portals, form
submissions. The 2026-09-21 design record
(archived/architecture/2026-09-21-chrome-acting-as-user-design.md)
sanctioned an agent-owned Chrome profile driven over the DevTools
Protocol; this is its implementation.

## Decision

- **Isolation**: `src/chrome.ts` launches the user's installed Chrome with
  `--user-data-dir=<App Support>/Anton/anton-chrome --remote-debugging-port=0`
  (ephemeral loopback port discovered through `DevToolsActivePort`). The
  profile is isolated from daily browsing; the window is visible and
  grabbable at any moment. `ensureRunning` attaches to an already-running
  agent Chrome first (probe `/json/version`) and spawns only when nothing
  listens — a previous window survives bridge restarts, and spawning a
  second instance never triggers the singleton handoff.
- **Tools** (blueant preset plugin `chrome.js`, bridge endpoints
  `/bridge/api/chrome/*`): `chrome_open` and `chrome_read` are ungated Ask
  tier (reading the agent profile's own tabs touches no user state);
  `chrome_fill` and `chrome_click` enqueue a human-readable proposal card
  ("Fill '#email' with '…' on 'Job application — Acme'") into the same
  ledger surface the shell proposals use, and the Mac app's existing
  Approve panel decides them — no new UI, no bulk grants.
- **Execution trust**: input goes through `Input.dispatchMouseEvent` and
  `Input.insertText` (trusted events, so site handlers behave — verified:
  the synthetic page's own submit handler ran), each fill is re-read from
  the page and reported back with what the field actually holds. The CDP
  action executes only inside the decide handler after the human click.
- **Preset migration**: the preset yml is content-aware — regenerated when
  `./plugins/chrome.js` is missing from it — so existing installs gain the
  four tools on next bridge start without touching user files.

## Testing

- Mechanical CDP round-trip against a synthetic data-URL form (isolated
  profile): open → read (form outline with labels, options, selectors) →
  trusted fill (value verified) → trusted click → the page's submit
  handler ran ("SUBMITTED blueant@test.dev").
- Preset generation exercised against a scratch dsh home: chrome.js
  bundles clean, stale yml (pre-chrome) is rewritten on regenerate.
- Read-tier endpoints are verifiable after deploy with plain curl; the
  fill/click approval path is exercised by the first real human decision —
  by design, no code path bypasses that click.

## Alternatives considered

AppleScript `execute javascript` and accessibility-tree clicks were
rejected in the design record; a Chrome extension + native messaging host
remains the long-term upgrade behind the same tool names.

## Consequences

The user signs into target sites once inside the agent window — the
deliberate trade for never granting the agent the personal profile.
Every page mutation costs one approval click; timeouts leave the card on
screen. `chrome_read` caps text at 12 KB and fields at 40 so a chatty
page cannot flood a session. Navigation (chrome_open) is ungated by
design — it reaches only the isolated profile, never the user's browser.
