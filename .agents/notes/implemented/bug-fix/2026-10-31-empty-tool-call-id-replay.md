# Agent Note: A tool call without a provider id must not corrupt the session log

Status: implemented

English

## Problem

A model can emit a tool call with an empty id (and an empty name). The block assembler copied the id verbatim (`partial.toolCallId ?? …` treats `''` as a present value), so the assistant message recorded `id: ""`, the dispatch failed with `UNKNOWN_TOOL`, and the `tool/result` message recorded `source.callId: ""` with a matching empty `toolCallId`.

Session replay requires a non-empty tool `source.callId`. Loading that session therefore failed with `SessionPersistenceCorruptionError`, and the whole transcript became unreachable — one degenerate model emission permanently broke the history of a working session.

## Decision

- **The assembler assigns an id when the provider supplies none.** `BlockAssembler` uses the streamed id only when it is non-empty; otherwise it derives `call-<block index>`. The same normalization applies to a complete `block-end` tool-call block, so a provider that closes a block directly cannot bypass it. The id is stable per message, which is all the log needs.
- **Replay accepts an internally consistent empty id.** `assertMessageEventShape` still requires `source.kind === 'tool'` and a string `callId`, but no longer rejects the empty string; the existing correlation check requires the message's single `tool-result` block to carry the same `toolCallId`. A result whose source is not a tool, or whose ids disagree, is still rejected. This is the compatibility path for logs written before the assembler fix.
- **The empty name is left alone.** The dispatcher answers `UNKNOWN_TOOL` and records a model-visible error result, which is the correct outcome; inventing a tool name would hide the model's mistake.

## Alternatives considered

- **Reject the model's empty-id emission at the LLM boundary.** Providers vary in how they encode ids, and a missing id is recoverable information rather than a protocol violation; failing the turn would punish a transient encoding quirk.
- **Repair the log on read.** Rewriting stored sessions inside the loader would mutate durable data behind the user's back and cannot be applied to a read-only replay; accepting the consistent pair keeps replay pure.
- **Require non-empty ids everywhere and quarantine the session.** That is the behavior this fixes: a single malformed emission destroyed access to 72k events of prior work.

## Consequences

New sessions never record an empty tool-call id. Existing sessions written before this change load and replay normally, including the `UNKNOWN_TOOL` result the model already saw. The derived `call-<index>` id is per message, so it cannot collide across steps, and it is never sent back to a provider (replay uses the recorded message).

## Testing

- `packages/llm/llm/tests/assembler.spec.ts` covers both paths: a streamed tool-call delta with an empty id, and a `block-end` block with an empty id, each producing `call-<index>`.
- `packages/core/session/tests/session.spec.ts` accepts a `tool/result` whose source and content both carry an empty call id, while the existing mismatch and non-tool-source cases still reject.
- Verified against the affected session (`session-3b02df9d-…`): the rebuilt app's `session.history` call returns `ok` with events where it previously returned `history unavailable`.
