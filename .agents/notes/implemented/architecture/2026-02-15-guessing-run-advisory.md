# Guessing-run advisory in repeat-tool-reminder

2026-02-15 · `guard/repeat-tool-reminder`

## Context

A live session burned four failed `cordis_inspect_query` calls on invented
provider ids. Each call had DIFFERENT arguments, so every existing detector
(identical-repeat chain, period-2 ping-pong) stayed silent; the model kept
guessing instead of discovering or asking. User direction: ambiguity should
route to a question for the human, and intent detection belongs in the loop
guard.

## Decision

The guard now tracks a per-agent consecutive-FAILED-call run per tool
(`failureThreshold`, default 3, fail-loud below 2). At the threshold it
delivers the guessing advisory once per episode: re-read the failure messages,
call the surface's discovery/list tool, or ask the user with
`ask_user_question`. A success breaks the run; the existing user-interjection
reset also breaks it. Deliberately NOT a veto: ambiguity is advisory — the
model may legitimately resolve the miss itself from the error text, and
forcing a human question on every third failure would be hostile. The ladder
(resolve → discover → ask → build) stays in the model's hands; the guard only
ends the silent-guessing regime.

## Consequences

- The inspect-probe failure pattern now costs at most `failureThreshold`
  failed calls before the loop guard names the escape.
- Failed-call runs add no new model-visible text beyond the one advisory.
