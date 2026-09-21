# Blueant settings panel — journal switch + model selection

2026-09-21 — antoncode workspace, Anton bridge + Mac app.

## What changed

- **`apps/anton-bridge/src/blueant-settings.ts`**: the persisted Blueant
  settings store — one JSON file at
  `~/Library/Application Support/Anton/blueant/settings.json`
  (`journalEnabled` default true, `model` `{provider, model} | null`).
  The in-memory copy flips on write so running loops honor a change on
  their next tick without a restart; a failed disk write still flips
  memory (the user's intent holds, the next good write re-persists).
- **`src/index.ts`**: `GET/PUT /bridge/api/settings` (same-origin) —
  read and partial-update the store.
- **`src/journal.ts`, `src/triage.ts`**: both loops check
  `journalEnabled()` at each tick; disabled means no capture and no
  triage, effective within one tick (≤60s).
- **`macos/HarnessClient.swift`**: `fetchSettings`/`putSettings` (bridge
  HTTP) and `listModels`/`selectModel` (harness RPC `session.models` /
  `session.selectModel`).
- **`macos/BlueantPanel.swift`**: gear button on the entry line (left of
  the mic tile) and ⌘, open a settings popover
  (`BlueantSettingsPane`): an NSSwitch "Journal (ambient capture)" and
  a model NSPopUpButton fed by the live session catalog ("Default"
  clears the preference). A model pick persists via the bridge AND
  selects on the live session; `resolveSession` applies the stored
  preference to each freshly created day session before the first
  prompt is sent, so the choice rides every new thread.

## Decisions and their reasons

- **The bridge store is the single source of truth.** The journal flag
  must reach the bridge loops anyway; keeping the model preference in
  the same file gives one persistence story for the popup, and
  session-create application makes the preference survive thread/day
  rotation without per-prompt wire changes (`session.prompt` has no
  model field — `session.selectModel` is the sanctioned setter).
- **NSSwitch + NSPopUpButton** are the platform idioms and visually
  match the web GUI's switch rows the user referenced.
- **Loops poll the flag per tick** rather than subscribing to writes:
  one tick of latency (≤60s) buys zero wiring complexity and survives
  bridge restarts reading the file fresh.

## Follow-ups

- The settings pane grows the remaining Blueant knobs (voice,
  notifications) on the same store as surfaces ship.
