# Agent Note: Chrome bridge acting-as-user — approve-gated design (Phase 4d extension)

Status: implemented

English

## Problem

The Act tier (blueant_propose) runs shell commands behind human approval,
but the highest-value agent actions live inside web pages: job
applications, form submissions, portal checks. Arivu's bar — the agent
acts as the user on the user's machine, gated — needs a browser surface
where every page mutation is proposed, human-readable, and approved
before it happens.

## Decision

**A dedicated agent-owned Chrome profile driven over the DevTools
Protocol (CDP), with every page action flowing through the existing
propose-then-approve verdict flow.**

- **Transport**: the bridge launches Chrome with
  `--user-data-dir=<App Support>/Anton/anton-chrome
  --remote-debugging-port=127.0.0.1:<ephemeral>` on first use and
  attaches over WebSocket (Bun's built-in WebSocket; zero new
  dependencies). The agent profile is isolated from the daily browsing
  profile — the user signs into target sites once inside it, and agent
  actions can never read or mutate the personal profile's cookies or
  tabs.
- **Tool surface** (Blueant roster, registered by a bridge-side plugin
  alongside blueant_propose): `chrome_open <url>`, `chrome_read` (text +
  form outline of the active page), `chrome_fill <selector> <value>`,
  `chrome_click <selector>`. Each mutating call internally becomes a
  proposal through the same `/bridge/api/propose` verdict endpoints, with
  a human-readable card ("Fill 'email' with '…' on 'Job application —
  Acme'") — per-action approval, no bulk grants, bounded waits identical
  to shell proposals.
- **Reading is ungated, mutation is gated**: chrome_open/chrome_read are
  Ask-tier (read-only) and bypass approval; fill/click are Act-tier and
  always propose. DOM evaluation uses `Runtime.evaluate`; input uses
  `Input.dispatch*` (trusted events) so site handlers behave.
- **Never**: no stored-credential exfiltration, no acting outside the
  agent profile, no mutating actions without a fresh approval card, no
  headless spoofing — the profile is a visible Chrome window the user can
  watch and grab at any moment.

## Alternatives considered

AppleScript `execute javascript` (needs Chrome's "Allow JavaScript from
Apple Events" opt-in, increasingly restricted, single-tab model).
Accessibility-tree clicks (fragile against canvas/virtualized DOM).
A Chrome extension + native messaging host (the robust long-term product
path, but an install-cert + packaging surface for v0; the CDP design
keeps the extension as an upgrade path behind the same tool names).

## Testing

Design record: transport and approval-flow claims map onto the shipping
blueant_propose endpoints and Bun WebSocket runtime (both in the repo
today); no code changed in this note. The implementation PR carries the
functional verification: launch → attach → read → proposed fill approved
by a human → click, plus the refusal path when a proposal is denied.

## Consequences

Backlog item closes as a sanctioned design; implementation is a 2-3 day
follow-up (bridge plugin + tool registration + proposal-card labels).
The agent-profile isolation means the user re-authenticates sites once
inside the agent window — the deliberate trade for never granting the
agent access to the personal profile.
