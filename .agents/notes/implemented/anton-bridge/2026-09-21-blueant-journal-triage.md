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

## Route correction (same day, after first live run)

The first install showed the real picture: the bridge env carries no
Moonshot key, and the deployment's working agent route is Kimi For
Coding — Anthropic-messages API at `https://api.kimi.com/coding`
(model family `kimi-for-coding` / `-highspeed` / `k3`), credential
`KIMI_CODING_API_KEY` in the app's
`~/Library/Application Support/Anton/dsh/.credentials.yaml` — the same
store `resolveContextApiKey` reads for the engine key. Triage now:
key `ANTON_TRIAGE_API_KEY` env then `.credentials.yaml`, endpoint
`/coding/v1/messages`, model `kimi-for-coding-highspeed`
(`ANTON_TRIAGE_MODEL` override). The settings.yaml moonshotai
apiKeyEnv block is an unused catalog entry, not the live route.

## Tier fallback and engine scoping (final, verified live)

- Kimi Coding's subscription quota is weekly; on quota-shaped failures
  (usage limit / 429 / 403) triage falls back to the store's Z.ai key
  with `glm-5.3-flash` at `api.z.ai/api/paas/v4/chat/completions` —
  the same cheap route Phase 7a plans for the Blueant main loop. The
  DeepSeek key in the store has no balance; Z.ai is the standing tier.
- Model output is parsed through an outermost-brace extractor — both
  tiers wrap JSON in prose or fences despite instructions.
- The engine rejects unregistered projects; evidence writes go to the
  registered `global` project, session `blueant-journal`. Verified end
  to end: 3 synthetic entries → glm-5.3-flash kept 2 (noise dropped) →
  3 evidence pages retrievable via `/context/query`.

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
