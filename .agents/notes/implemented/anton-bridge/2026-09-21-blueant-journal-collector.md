# Blueant phase 5a — the journal collector (ambient ingestion lane)

2026-09-21 — antoncode workspace, Anton bridge.

## What changed

- **`apps/anton-bridge/src/journal.ts`**: `startJournalCollector()` runs
  for the bridge's lifetime (default 60s cadence,
  `ANTON_JOURNAL_INTERVAL_MS` override) and appends Arivu-style entries
  to one markdown file per day under
  `~/Library/Application Support/Anton/blueant/journal/` (`YYYY-MM-DD.md`,
  first write creates a dated header; screenshots land in `screenshots/`).
  Each visible change appends a `## HH:MM:SS` block with `app:`,
  `window:` (when readable), `url:` (browsers only), `clipboard:` (only
  when changed), and `screenshot:` (only on visible change, min 120s
  gap, silent JPEG via `screencapture`).
- **`src/index.ts`**: the collector starts right after the server binds.

## Decisions and their reasons

- **Spawned macOS utilities, not native APIs.** The bridge is a Bun
  process; child processes inherit the app's TCC attribution, so the
  Accessibility/Screen Recording/Automation grants Anton already holds
  cover `osascript`, `pbpaste`, and `screencapture`. A denied probe
  degrades the entry silently — the journal shrinks, never breaks.
- **Write on visible change only.** Idle minutes produce nothing; the
  journal stays readable by a human and cheap to triage (5b).
- **Fail-soft with one observable trail.** A tick failure logs
  `console.warn('[journal] tick failed:', …)` into bridge.log and
  retries next tick — the collector must never be able to take the
  bridge down, but a silently-stalled journal would be undiagnosable.
- **In-memory change keys only.** No state files: after a bridge
  restart the first tick writes one entry (the current context) and
  dedupe resumes. Correct because entries are timestamps, not deltas.

## Failures met on the way

- The first standalone smoke wrote nothing while every probe worked —
  the bare `catch {}` made the tick undiagnosable. Lesson recorded
  above: fail-soft needs exactly one observable trail.

## What this unblocks

- 5b: cheap-model triage reads these markdown entries and writes
  worth-keeping facts into c0ntext as evidence.
- 5c: the scheduled dream cycle can mine journals alongside session
  memory for consolidation.
