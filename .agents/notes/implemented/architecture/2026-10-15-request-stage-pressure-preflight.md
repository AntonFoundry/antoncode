# Agent Note: Request-stage context pressure preflight

Status: implemented

English

## Problem

Automatic pressure compaction ran at `agent/pre-step`, before the claimed message batch entered the durable surface and before `agent/request` selected and resolved the final provider/model route. A request could therefore exceed the selected model's context threshold even when the pre-step estimate was below the previous model's threshold. The initial request had no logged route and skipped pressure entirely.

## Decision

The loop awaits serial `agent/request-prepared` after resolving the final adapter call and logging its canonical request header and context capacity, but before deriving and freezing request messages. The notification carries the exact provider/model, optional context capacity, the derived messages, turn/step, and cancellation signal. The loop derives messages again after listeners settle, so durable compaction replacements are reflected in the dispatched request.

`dsh-compaction-basic` uses the prepared route and capacity, and estimates messages not yet on the session surface in addition to the durable meter result. Pressure therefore applies to the initial request, the actual route selected by request middleware, the assembled system prompt and tools, and the incoming message batch. Within the pressure path, the active-compaction lock scan runs only after the target-specific threshold qualifies and before any surface mutation, so unpressured requests never pay its O(session log) walk; the capacity-misconfiguration error still fires on every pressure check regardless of threshold. Provider-confirmed context overflow remains a bounded backstop when heuristic estimation or compaction cannot make the request safe.

This decision partially supersedes the [after-call pressure decision](2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md): successful pressure is no longer triggered at the next pre-step from only the previous durable route. The [claimed pre-step lifecycle](2026-07-31-claimed-pre-step-inbox-lifecycle.md) remains authoritative for inbox ownership and admission.

## Alternatives considered

**Add pending-message estimates to `agent/pre-step`.** This misses the final request route, adapter capacity, and complete assembled header, and can require resolving routing twice.

**Rely on provider overflow recovery.** This preserves bounded recovery but makes the provider reject requests that proactive compaction could have reduced, and cannot repair an envelope that alone exceeds the limit.

**Intercept `llm/stream`.** The request is already frozen at that point, so the interceptor would need to invent request-rebuild and retry behavior and avoid capturing auxiliary compaction calls.

## Consequences

Pressure work occurs inside the open step after the canonical request header is logged. Compaction writes remain durable and the loop rebuilds the messages from that surface before dispatch. The estimator remains heuristic; indivisible oversized content and request envelopes alone may still require provider recovery or fail unchanged.

## Verification

The real-loop regression seeds a routed session below threshold, admits an incoming batch that crosses it, selects the final route through `agent/request`, and verifies that the prepared request compacts old history before dispatch while retaining the incoming batch. Focused compaction and loop tests exercise ordering and reconstruction; documentation checks cover the updated API and decision record.
