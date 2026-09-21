# Agent Note: Retry affordance for failed turns

Status: implemented

English

## Problem

A turn that dies — an LLM request timeout (`DOMException: The operation was aborted due to timeout`), a provider 4xx, a plugin crash — renders the `turn-error` row ("This turn failed") and nothing else. The row is terminal chrome: no control, no hint. The host keeps the session perfectly usable (the failed turn's `user/message` was persisted before the step ran, and the agent idles after `turn/end {reason: error}`), so recovery has always been possible — but only by retyping the original prompt from memory. The one failure surface the GUI shows was the one surface with no gesture on it.

## Decision

Retry is a client-side gesture in `ui-conversation`, reusing the existing queued-prompt path; the host gains nothing. It sits one layer above the [bounded per-model-request recovery](../architecture/2026-06-21-bounded-llm-request-recovery.md): that chain retries failures inside the turn; this gesture is the human escalation for turns that still ended in `turn/end {reason: error}`.

- **Inject face**: `ChatViewInjected.retryTurn(text)` resolves the session binding in `apply.ts` and calls `session.prompt([{ type: 'text', text }], 'queue')` — the same call the composer's send makes. Failures surface through the existing snapshot `promptError`; the console line names the gesture when the RPC itself fails.
- **Arming** lives in `ChatView` as a derived `trailingRetry` value: the flow tip must be the `turn-error` node, the session must be idle with an empty queue, and the failed turn's input must resolve to non-empty plain text. The failed turn's input is the nearest preceding `user` node walking `chat.order` backwards — user messages log before their `turn/start`, so they never appear in the turn location index. Image-bearing and unrecognized-block inputs disarm Retry (attachment re-upload would need the draft-attachment path); a failure followed by later flow activity also disarms, so Retry only ever re-submits the session's actual tail.
- **Delivery**: the armed value rides the existing owner-prop currency (`ChatNodeOwnerProps.retry`) to the trailing seat only, and `TurnErrorItem` renders a small `重试`/`Retry` button when it is present. No new slot, no new store, no node-definition change — the `turn-error` node's data is untouched.

Retry re-sends the text as a **new** user turn. The failed turn's durable `user/message` stays in the log, so the model sees both the dead prompt and its re-submission. This matches the established turn-level recovery precedent (the max-tokens notice tells the user to send "continue"); the alternative of rewriting history belongs to the fork machinery, not to a recovery gesture.

## Testing

Component specs in `chat-view.client.spec.tsx` cover arming on the trailing failure with resend of the original text, the hidden cases (running, queued prompt, later flow node, image-bearing input, no resolvable input), and the bare-row rendering of an earlier failure. `apply-inject.client.spec.tsx` drives `retryTurn` through the real inject factory to the session fake's `prompt`. The error-banner web e2e golden gains the button and is refreshed deliberately.

## Alternatives considered

**A host-side resume/re-run endpoint.** A `sessions.retry(turn)` that replays the failed turn in place would avoid the duplicate user message, but it needs new authority over the event log (the failed turn's records cannot be un-seen by a resume that appends after them), a new wire verb, and host-side idempotency against a session that may have moved on. No consumer needs in-place replay today; queued re-submission reaches the same model state for a fraction of the surface.

**Fork-excluding the failed turn, then sending.** Composing the existing `forkExcluding` with the retry send would keep the log clean, but it mints a new session identity for every retry, breaks in-flight links (open details targets, scroll anchors), and archives the original session as a side effect of what reads as "try again".

**Automatic retry with backoff.** The per-model-request `llm/retry` chain already retries transport-class failures inside the turn; a turn that still ended in `turn/error` exhausted that layer. Re-firing whole turns without a human gesture risks repeated tool-side effects and cost, which is exactly what the terminal banner exists to escalate.

## Consequences

The most common dead-end states — timeout, provider auth, crash — now have a one-click recovery that costs no history rewriting and no new host authority. The cost is honest: the retried conversation carries the failed turn's user message twice, so token accounting grows by one repeated prompt, and attachment-bearing prompts still require manual resend. Retry stays a trailing-tail gesture; recovering a failure buried under later activity remains the user's own composition problem.
