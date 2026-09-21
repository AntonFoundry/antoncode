# Phase 5c — scheduled consolidation (the bridge-timer power nap)

2026-09-21 — antoncode workspace, Anton bridge.

## What shipped

- **`apps/anton-bridge/src/cheap-model.ts`**: the deployment's cheap-model
  route as a shared helper — Kimi For Coding (Anthropic-messages,
  `KIMI_CODING_API_KEY`) with Z.ai `glm-5.3-flash` as the weekly-quota
  fallback, plus the brace-span JSON extractor. `ANTON_TRIAGE_API_KEY` /
  `ANTON_TRIAGE_MODEL` envs still override; per-call `model` wins over all.
  `src/triage.ts` was slimmed onto it (its private HTTP code deleted).
- **`src/consolidate.ts`**: `startJournalConsolidation` — a wall-clock timer
  (first pass +5 min, then every `ANTON_CONSOLIDATE_INTERVAL_MS`, default
  6 h) that runs the engine's two-phase dream: `POST /dream/propose` mines
  candidates, each is distilled into one durable third-person lesson with an
  `[importance: …]` tag through `cheapChat`, and `POST /dream/commit`
  persists the enriched candidates (promotion stays engine-gated; enriched
  candidates arrive with `enriched_by`, so the engine's own unenriched
  polisher queue skips them). Each cycle appends one line to
  `journal/.consolidation-log.md`. Honors the journal settings flag.
- **`src/index.ts`**: wired next to the triage start;
  `ANTON_CONSOLIDATE_PROJECT` overrides the dream project (default
  `global` — Blueant's journal-evidence memory).

## Decisions and their reasons

- **Why a bridge timer at all**: the engine already dreams on harness idle
  (`dreamIdleHours`), but an always-active machine rarely idles; the wall
  clock guarantees the cadence. The two paths compose — both produce
  promotion-gated candidates.
- **Local-dream grace**: `/dream/propose|commit` are free to private
  loopback callers; the bridge is the user's own harness, so no add-on
  gating applies.
- **0-candidate cycles are silent by design** (verified live against both
  `global` and `antoncode` — the miners' confidence gate currently returns
  none); the log only records cycles that mined or failed, so the file
  stays signal.

## Verification

- Live: `dream/propose` against the running engine returns
  `{status, candidates: []}` for both projects; the 0-path exits cleanly.
- Wire shapes checked against `worker/worker.py` (`dream_propose`,
  `dream_commit` — returns `committed: <n>`, which the result parser reads).
- Enrichment tier proven live in Phase 5b (same shared `cheapChat`).

## Follow-ups

- First real install lands with the next restart window; watch
  `.consolidation-log.md` for the first mining yield as journal evidence
  accumulates.
- If miners stay at 0 on `global`, consider pointing
  `ANTON_CONSOLIDATE_PROJECT` at `antoncode` (richer memory) or feeding the
  dream window from the triage ledger directly.
