# @deepseek-ai/dsh-resume-note

Opt-in durable notice on the first turn after a crash-interrupted tail turn.

When a harness process dies mid-turn (restart, crash, kill), the persistence
repair commits a synthetic `turn/end { reason: { kind: 'interrupted' } }`
closer for the orphaned tail at next load. This plugin consumes that durable
fact on the model side: at step 1 of the following turn it appends one
plugin-sourced notice so the model knows the transcript gap is a harness
restart, not user intent — the user's next message almost always means
"continue".

## Behavior

- Fires only when the last `turn/end` in the durable log carries
  `reason.kind === 'interrupted'` and no resume note follows it.
- Appends exactly once per interruption; a fresh interruption after a
  delivered note gets a fresh note (stacked restarts).
- The note is a `user/message` whose source is this plugin's own kind,
  `{ kind: 'resume-note', form: 'notice', summary: … }`; the loop logs it like
  every pre-step message, so model-visible ⟺ logged holds with zero loop changes.

## Config

| field | type | default | effect |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | `false` suppresses injection without removing the plugin row |
| `text` | string | see `DEFAULT_NOTE_TEXT` | overrides the model-visible note text |

## Model experience

- One extra user-role notice (~40 tokens) on the first turn after an
  interrupted tail; none afterwards. No effect on KV cache beyond that
  single turn's history.
- The default text is pinned by unit tests; override it consciously.

## Known Limitations and Deferred Work

- Detection trusts the repair-committed `interrupted` marker only; a
  harness killed before any `turn/start` flush produces no marker and
  therefore no note (correct: nothing was interrupted).
- No dedicated `resume-note-delivered` session event; non-plugin
  consumers should read the plugin-source `user/message` from the log.
