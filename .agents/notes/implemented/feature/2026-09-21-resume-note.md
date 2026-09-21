# Agent Note: Resume note for crash-interrupted turns

Status: implemented

English

## Problem

When the harness process dies mid-turn (restart, crash, kill), the user's next
message lands in a session whose transcript simply stops. The model sees the
interruption as an unexplained gap and often re-asks or re-derives state —
observed repeatedly during Anton bundle swaps and `dsh anton restart` cycles.

The durable fact already existed: the persistence repair commits a synthetic
`turn/end { reason: { kind: 'interrupted' } }` closer for a crash-orphaned
tail at first load (`interruptedTurnClosers` → coordinator `commitRepair`).
Nothing model-facing consumed it.

## Decision

A new opt-in function plugin, `@deepseek-ai/dsh-resume-note`, on the
`agent/pre-step` waterfall (time-context's family):

- **Trigger**: step 1 of a turn whose backward scan finds the last
  `turn/end` is `interrupted` and no plugin-source resume note follows it.
  The scan window between the last `turn/end` and the open step is exactly
  the resume window, so stacked restarts each earn their own note and
  delivered notes never repeat.
- **Injection**: one `user/message` with `source: { kind: 'plugin', plugin:
  'resume-note', form: 'notice', summary }`. The loop logs every pre-step
  message, so model-visible ⟺ logged holds with zero loop changes; the
  `notice` form renders as a collapsed one-liner in the UI.
- **Config**: `enabled` (default true), `text` (default pinned by tests) —
  deployment-varying text is a validated Config field, not a constant.
- No bridge-side marker: the bridge SIGTERMs the harness knowing nothing of
  sessions; the committed repair is the reliable signal.
- Package invariant: a note requires a preceding interrupted `turn/end`,
  at most one per interruption.

## Testing

Unit: 8 spec cases (inject-once, stacked restarts, step guard, empty log,
enabled=false, custom text, fiber disposal). Invariant: 4 cases (accept,
wrong end kind, no end, duplicate). Keyless e2e through the real Loader
(`runLoaderSmoke`, src + lib modes): a headless fixture drives one completed
turn, appends a crash-open tail, re-boots, `agents.resume` repairs the tail,
and the next turn carries exactly one note with verbatim default text,
sequenced between the interrupted end and the normal end. Live: the first
post-deployment `dsh anton restart` interrupted the author's own turn and
the note appeared verbatim in the next turn's context.

## Alternatives considered

A dedicated `resume-note-delivered` SessionEventMap member: only the
plugin-source `user/message` is needed; deferred until a non-plugin consumer
appears (would carry `ignorable: true`). A bridge restart_pending marker:
strictly weaker than the durable repair — the bridge knows nothing about
sessions and the SIGTERM grace window cannot guarantee a write.

## Consequences

Opt-in per repo policy; the Anton web profile wires it via the live DSH home
(`Application Support/Anton/dsh/profiles/web` — package link plus
`cordis.patch.yml` insert row; `~/.dsh` and `~/.anton/dsh` are inert copies).
Restart-interruption churn now self-explains instead of costing a diagnostic
turn. The same change removed the dead translation-pairing probe from
`scripts/install-lefthook.mjs` that broke every `pnpm install` postinstall.
