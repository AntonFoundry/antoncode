---
description: "Opt-in durable notice marking a crash-interrupted tail turn as a harness restart."
kind: "package-reference"
---

# @deepseek-ai/dsh-resume-note

English

## Summary

Tell the model when the previous turn ended with a durable interruption marker. At the first accepted step of the following turn, the plugin records one source-attributed notice so the model can resume the standing task. The notice is not repeated for the same interruption, and deployments can disable it or replace its text.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Config](#config)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Understand the implementation

- Fires only when the last `turn/end` in the durable log carries `reason.kind === 'interrupted'` and no resume note follows it.
- Appends exactly once per interruption; a fresh interruption after a delivered note gets a fresh note (stacked restarts).
- The note is a `user/message` whose source is this plugin's own kind, `{ kind: 'resume-note', form: 'notice', summary: … }`; the loop logs it like every pre-step message, so model-visible ⟺ logged holds with zero loop changes.

## Config

| field | type | default | effect |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | `false` suppresses injection without removing the plugin row |
| `text` | string | see `DEFAULT_NOTE_TEXT` | overrides the model-visible note text |

## Model Experience

### Crash-interruption notice

#### What the model sees

At the first step after a durable interrupted tail, an accepted decision receives one logged `user/message` with source kind `resume-note`. The default text is below; `text` can replace it.

##### Default notice

```markdown
[harness] The previous turn was interrupted by a harness restart before it completed. Treat the user's next message as resume: continue the standing work from where the transcript stops, without re-asking what was interrupted.
```

#### Token effect

One notice adds tokens proportional to its configured text. Later steps add no duplicate notice for that interruption.

#### KV Cache effect

The notice appends to retained Session history rather than rewriting earlier messages; it remains in subsequent context until ordinary history management removes it.

## Known Limitations and Deferred Work

- Detection trusts the repair-committed `interrupted` marker only; a harness killed before any `turn/start` flush produces no marker and therefore no note (correct: nothing was interrupted).
- No dedicated `resume-note-delivered` session event; non-plugin consumers should read the plugin-source `user/message` from the log.

### Dev Note

- The notice is not injected through `agent.inject()`: that path queues for the next step, while the resume point is the step being assembled. Appending to the `agent/pre-step` decision keeps the message on the open step and inside the loop's own logging, so the transcript stays the single source of truth.
- The plugin declares its own message source kind rather than reusing a shared one, so a consumer can identify its notice without matching on text.
