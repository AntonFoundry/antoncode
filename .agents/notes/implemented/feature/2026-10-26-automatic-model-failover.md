# Agent Note: Host-owned automatic model failover

Status: implemented

## Problem

A retry on the same provider cannot recover an exhausted account or an unavailable model. Changing the user's saved model preference to recover one request also makes a temporary outage a lasting configuration change. Hidden adapter retries cannot explain a route change in the Session or rebuild the next request's provider-specific configuration.

## Decision

The Host's `llm-retry` plugin owns optional ordered failover chains, bounded recovery and cooldown. This partially supersedes the failover exclusion in [bounded request recovery](../architecture/2026-06-21-bounded-llm-request-recovery.md); that note still owns structured failure facts and same-route retry. Each route names an exact provider and model. The core loop exposes preadmission model selection and attempt-local route recovery; it resolves the effective route before forming a new request. Automatic recovery leaves the manual and global model preferences unchanged.

The policy limits eligible provider failures, skips routes that cannot carry the admitted context, and bounds recovery attempts. Its recovery actions carry an absolute expiry through target admission, request preparation and dispatch. These operations and third-party adapter metadata resolution must honor cancellation; work that ignores its abort signal can outlive the elapsed-time budget.

Recovery does not authorize hidden compaction to fit another route. Every assembled target request receives a final capacity check using a conservative serialized-input byte bound, available token measurements, output reserve and configured headroom. Retained images and files currently refuse automatic route recovery because the capacity check has no attachment bound; a target's declared image support or larger context window does not waive that refusal. Recovery never drops attachments to make a request fit. Authentication, invalid requests, context failures, cancellation and tool failures do not authorize switching. A logged notice makes each switch and terminal exhaustion visible without exposing raw provider responses or credentials.

Session Projection restores cooldown and recovery facts from durable events. Replay reconstructs state without repeating waits, notices or provider calls. Model-visible notices remain ordinary persisted messages; recovery does not synthesize them while reading history.

The new log-only events remain required records, not ignorable audit data. A reader without their vocabulary refuses the Session instead of silently discarding recovery state. This uses the existing same-version admission mechanism; it neither advances the writer version nor rewrites historical generations. The [persistence acknowledgement](../../../../docs/persistence-changes/2026-10-26-automatic-model-failover.md) owns the exact type transition and reader evidence, and the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.2/automatic-model-failover/guide.md) owns operator actions.

## Alternatives considered

**Retry only the original route.** This retains existing behavior when failover is disabled, but cannot recover account quota or model unavailability.

**Switch inside each provider adapter.** An adapter cannot coordinate another provider's capabilities, the Host's saved preference or durable Session recovery. Route selection belongs above adapters.

**Replace the saved model preference.** A transient outage does not authorize a lasting user choice. Effective routing remains separate from explicit selection.

**Treat recovery events as ignorable.** The existing typed Session writer does not offer ignorable metadata for these records. Required events already give older readers a safe refusal path without expanding core Session APIs.

## Consequences

Failover is opt-in and configuration controls its costs. Recovery can use a different provider, so deployments explicitly choose their allowed route order. Capability checks can reject otherwise available routes when context or modality support is insufficient or unknown.

Older readers can still open feature-free Sessions, but cannot resume Sessions containing these required events. Disabling the policy stops future switching; it does not remove historical records or make an old reader compatible. Verification covers bounded attempts, cooldown recovery, preference isolation, truthful request headers, cancellation, required-event refusal without truncation and keyless Session replay.
