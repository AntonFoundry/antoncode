# Blueant act tier v0 — blueant_notify through the bridge notification inbox

2026-09-20 — antoncode workspace, Anton bridge + macOS app + Blueant preset.

## What changed

- **Bridge** (`apps/anton-bridge/src/index.ts`): an in-memory notification
  inbox (bounded at 20) with three loopback routes —
  `POST /bridge/api/notify` (enqueue `{title?, body}`, guarded by
  `loopbackControlAllowed`, i.e. no browser Origin), `GET
  /bridge/api/notify/pending`, and `POST /bridge/api/notify/ack {ids}`.
- **Mac app** (`AntonApp.swift`): the existing 2s status poll now also
  pulls `/bridge/api/notify/pending`, requests notification authorization
  lazily on the first delivery (the macOS dialog is the approve-once
  gate), presents each notification through UNUserNotificationCenter, and
  acks by id so the queue drains. A `UNUserNotificationCenterDelegate`
  presents banners even when the accessory app is frontmost; without it
  macOS silently drops foreground banners.
- **Blueant preset**: a new import-free `plugins/notify.js` registers the
  `blueant_notify` tool (body required, title optional) that POSTs to the
  bridge; the roster allow list gains `blueant_notify`. Both the template
  in `blueant-preset.ts` and the deployed
  `~/Library/Application Support/Anton/dsh/.agent-presets/blueant/` copy
  carry the change — the preset writes are existsSync-guarded, so the
  deployed yml/plugin were updated in place.

## Decisions and their reasons

- **Poll-and-ack, not push.** The bridge (Bun) has no channel into the
  app (Swift) today; the app already polls the bridge every 2s, so the
  inbox rides that existing cadence. Worst-case delivery latency is one
  poll interval; no new port, socket, or entitlement.
- **The notification permission dialog is the gate.** One request, lazy;
  a denial acks everything and never nags again — same posture as the
  Screen Recording gate in the capture tier.
- **Bounded queue (20)** so a chatty agent cannot flood the notification
  center; oldest entries drop first.
- **Authorization callback acks on denial on a background queue**; delivery
  and ack happen inside the same callback so a denied grant cannot strand
  entries in the bridge inbox.

## Failures met on the way

- `bun` is not on the default agent-shell PATH; bridge smoke-builds need
  `/opt/homebrew/bin` prepended (the app build script already handles
  this internally).

## What this unblocks

- Realized the same day: propose-then-approve rides this inbox with a
  `kind: 'proposal'` payload — see 2026-09-20-blueant-propose-approve.md.
- Phase 5 consolidation ("power nap") can announce finished dream cycles
  through `blueant_notify` for free.
