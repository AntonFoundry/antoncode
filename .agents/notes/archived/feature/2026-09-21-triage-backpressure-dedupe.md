# Agent Note: Journal triage backpressure and dedupe (Phase 6c)

Status: implemented
Archived: 2026-10-30

English

Date: 2026-09-21
Scope: apps/anton-bridge/src/triage.ts

## Problem

The journal collector samples every 60s; triage classifies each batch on
the cheap model and writes kept facts into c0ntext (project `global`,
session `blueant-journal`). Three failure shapes emerged as journal volume
grows:

1. **Duplicate facts.** The same observation recurs for hours and days
   (same project, same site), and the cheap model phrases each triage
   slightly differently, so near-identical facts accumulated — the same
   pattern the dream cycle kept flagging as duplicate memories elsewhere.
2. **Unbounded bursts.** A backlog (first triage over an old journal, or
   after the machine slept) wrote every kept fact in one cycle.
3. **Degraded-engine hammering.** A slow engine made every write time out;
   the cycle retried on every interval regardless.

## Change

- **Dedupe at capture**: a fact is dropped when its normalized text
  (stamp-stripped, casefolded, whitespace-collapsed) was written before
  (FNV-1a hash set), or when its informative-token Jaccard similarity to
  any recent fact is ≥ 0.8. State persists in
  `journal/.triage-seen.json` (bounded: 2000 hashes, 200 recent facts).
- **Backpressure**: per-cycle write cap (25) and per-day cap (150).
  Entries now carry byte offsets; the watermark advances only past fully
  processed batches, so a capped cycle resumes at the first unprocessed
  entry and nothing is lost or double-classified.
- **Failure backoff**: after 2 consecutive failed cycles the loop skips
  intervals, doubling up to an hour.
- Corrupt/missing seen-state degrades to empty (worst case: a few
  duplicate writes, never lost entries).

Facts that are dropped by dedupe do NOT advance the day counter — noise
must not consume the budget real observations need.

## Verification

- `npx tsc -b tsconfig.client.json` clean.
- Live: bundle install + observe `[triage] N entries seen, K kept` lines
  and `.triage-seen.json` growth against a real journal.

## Non-goals

Engine-side zone budgets for journal evidence (crowding protection inside
manifests) — the dedicated `blueant-journal` session plus capture-time
dedupe is the current isolation; revisit if global-project recall noise
shows up in practice.
