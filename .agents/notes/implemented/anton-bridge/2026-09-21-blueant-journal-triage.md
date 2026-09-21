# Blueant phase 5b — cheap-model triage of journal entries into c0ntext

2026-09-21 — antoncode workspace, Anton bridge.

## What changed

- **`apps/anton-bridge/src/triage.ts`**: `startJournalTriage()` runs a
  first pass 30s after bridge boot, then every 5 minutes
  (`ANTON_TRIAGE_INTERVAL_MS`). Each cycle walks the journal directory's
  day files from a per-file byte watermark
  (`.YYYY-MM-DD.md.triage-offset`), parses complete `## HH:MM:SS`
  entries, batches up to 10 per call to the deployment's moonshotai
  route (`kimi-k2.7-code-highspeed` default, `ANTON_TRIAGE_MODEL`
  override), and writes kept facts to the c0ntext engine
  (`POST /pages/archive`, project `blueant`, session `journal-triage`)
  as `"<day> <time> — <fact>"`. Kept-fact ledger at
  `journal/.triage-ledger.md`.
- **`src/index.ts`**: the triage loop starts next to the collector and
  receives the already-resolved context endpoint + API key.

## Decisions and their reasons

- **Byte watermark with a write-head rule.** The collector appends
  concurrently; the last `##` block without a trailing blank line is
  its in-progress write, so the triage parser excludes the trailing
  incomplete block and advances the watermark only past complete ones —
  entries are never triaged twice and never skipped forever.
- **The model route mirrors the deployment's own provider config**
  (`apiKeyEnv: MOONSHOTAI_API_KEY` from `~/.dsh/settings.yaml`,
  highspeed tier of the same k2.7 family) rather than introducing a
  second provider; one credential surface, one billing story.
- **Kept facts are single self-contained sentences** with the journal
  stamp prefixed — searchable verbatim via c0ntext, source-linked by
  timestamp back to the journal file.
- **Fail-soft, one observable trail**: a failed cycle warns into
  bridge.log and retries from the unchanged watermark; a missing key
  skips the cycle with a named warning instead of erroring.

## Failures met on the way

- `ENTRY_HEADING` lacked the `m` flag, so `^…$` never matched a heading
  followed by body lines — triage silently saw zero entries. The
  block-split regex had `/m`; the per-block match must too.
- `launchctl getenv` from this session's bootstrap namespace reads empty
  even for variables the launchd GUI domain holds — env presence must be
  judged from the process that owns the variable's lifecycle (the app's
  working model calls prove the key), not from an unrelated shell.
- The provider's env var is `MOONSHOTAI_API_KEY` (per provider config),
  not `MOONSHOT_API_KEY`.

## What this unblocks

- 5c: the dream cycle consolidates on a bridge timer; triaged journal
  evidence is already source-linked and `observed_at`-stamped, so the
  consolidation can mine it alongside session memory.
