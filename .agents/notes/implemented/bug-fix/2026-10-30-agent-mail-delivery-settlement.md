# Agent Note: Agent Mail separates committed delivery from browser refresh

Status: implemented

## Problem

A queue send and the mailbox refresh that follows it settle independently. Treating their combined promise as one delivery outcome lets a refresh failure restore a draft that was already sent, inviting duplicate delivery. Sending several direct recipients separately also permits partial delivery before a later recipient fails. Concurrent sends, refreshes, revocation, and reauthorization can publish stale browser state unless each result belongs to the current authorization lifetime and refresh request.

The [resident-composer decision](../feature/2026-10-30-agent-mail-resident-composer.md) owns routing mail through the shared input. The [authorization decision](../architecture/2026-10-26-agent-mail-local-authorization.md) owns access. Neither makes browser refresh part of the Host queue's delivery commit.

## Decision

The browser Gateway submits direct recipients in one Host Remote call. A successful queue publication produces an `AgentMailSendOutcome` receipt; a later refresh failure produces `refreshError`, not rejection of the committed send. The composer therefore completes the submission rather than restoring a duplicate draft. Authorization and publication failures still reject.

The Gateway owns outgoing browser rows and publishes a committed receipt before awaiting refresh. Refresh preserves current outgoing rows, so another send's completion cannot erase them. An authorization-lifetime identity prevents old send or refresh completions from repopulating a revoked or reauthorized mailbox. Refresh-request identity prevents an older refresh from replacing a newer snapshot. These checks govern presentation only: revocation of browser state cannot undo a Host queue commit.

The selected channel determines mention candidates and admissible recipients before publication. Local mail addresses same-workspace peers or broadcasts when unaddressed; direct mail addresses peers in other workspaces. A known wrong-channel mention rejects without silently broadcasting or partially sending. This corrects the existing channels; it does not add a recipient picker or another delivery transport.

The feed distinguishes queue mail from adjacent-Agent correspondence. Queue-tool outgoing rows use complete canonical successful result JSON, not draft arguments; truncated results are excluded because delivery may have succeeded without enough evidence to display its receipt. Adjacent-Agent correspondence retains its existing logged message attribution. Neither projection delivers mail or appends Session events.

## Alternatives considered

**Reject the send when refresh fails.** Rejected: the Host commit has already occurred, and restoring the draft misrepresents delivery. Refresh has its own recoverable warning.

**Send once per direct recipient.** Rejected: multiple commits can expose a partially delivered submission. The Host already accepts one recipient array.

**Keep a separate post-refresh sent log.** Rejected: a committed send can reject during refresh before its row reaches that log, and a separate store does not share the Gateway's authorization lifetime. Gateway ownership publishes receipts before refresh and clears browser rows with authorization state without claiming a durable sent archive.

**Publish any completed refresh while the mailbox is authorized.** Rejected: revocation followed by reauthorization is a different lifetime, and older requests within one lifetime can finish last. Both identities must remain current before publication.

## Consequences

Callers migrate from `recipient` to `recipients` and from void sends to receipt outcomes, as described in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.2/agent-mail-delivery/guide.md). A refresh warning calls for another read, never an automatic resend. Gateway outgoing rows are ephemeral and clear with browser authorization state; Host queues and Session logs remain the durable owners. Queue delivery remains non-waking, and no new message source or Session format is introduced.

Queue-tool rendered results are limited to 16000 characters; an excluded truncated result means the feed lacks an outgoing row, not that delivery failed. This change supplies neither a durable sent-mail archive nor a new cross-workspace picker.
