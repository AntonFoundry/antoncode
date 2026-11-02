# Agent Note: Agent Mail authorizes the local UI without a native code

Status: implemented

English

## Problem

Agent Mail's browser view was a read-only preview behind a native-display pairing ceremony: a same-origin request asked the bridge to display an eight-character code in the native Anton window, and the browser had to paste it back before reading or sending queue mail. The ceremony protected a real capability — the browser acts as a specific live Agent — but on the same machine it proved nothing the HTTP carrier did not already prove, and it made the mailbox unusable for its actual product role: a durable, addressed coordination bus for a main agent and its subagents.

The agents themselves never used the ceremony. They already coordinate through `ctx.agentQueue` (workspace mailbox with explicit recipients, broadcast subscription, cursors, and acknowledgement), `ctx.agentDirectQueue` (cross-workspace direct ledger), and the `agent_queue_*` tools, with a bounded unread digest at natural model steps. Only the browser surface was gated.

## Decision

`agentMail.authorize` mints a grant directly for the same-origin harness UI. The HTTP carrier already restricts Agent Mail requests to the bridge-proven loopback origins (`antoncode.localhost:3742`, `localhost:3742`, `127.0.0.1:3742`) and rejects an unproven Origin before dispatch, so the native display adds no proof for this same-machine caller. The grant keeps every property of a redeemed one: it is scoped to the exact live Agent object, origin, workspace, and operation set, expires after 30 minutes, and is revoked when the Agent is replaced. A viewed session that is cold after a restart resumes through the same session path every other session RPC uses (`agentFor`) before the grant is minted. The view authorizes itself on mount; the native `begin`/`redeem` wire and its display machinery remain for non-local clients but are unused by this UI.

The tab presents the mailbox as channels (`general` for the workspace queue, `direct` for cross-workspace mail) with a grouped message feed, per-agent avatars, and a composer that addresses one peer by name or broadcasts to subscribers. Names come from a deterministic Docker-style adjective+surname generator keyed by session id, with a six-hex discriminator (`Brave Turing #9718a9`, the Discord convention) so two identically named agents remain distinguishable within a session or workspace. The id remains the address, so name collisions never affect delivery. A human using the tab acts as the viewed session's Agent and can therefore message any listed peer directly.

The Orchestrator tab is no longer mounted in the web application composition.

## Alternatives considered

**Keep the native code and make it automatic.** Rejected: displaying a code nobody reads and pasting it programmatically is ceremony without proof.

**Drop Agent Mail and route the user to the tools.** Rejected: the durable mailbox already exists and the authorized view is a complete reader/sender over it; removing the surface would hide an operational queue the main agent needs to inspect.

**Auto-subscribe every new subagent to workspace broadcasts.** Deferred: the queue's durable subscription is explicit, and changing delivery for every agent is a separate product decision about digest noise, not part of removing this gate.

## Consequences

Any script delivered by the harness origin can act as a live Agent in that workspace while a grant is live; other origins remain denied by the bridge proof. The native consent code no longer appears in the product flow. Agents keep the existing queue vocabulary, digest, and acknowledgement semantics; no delivery, wake-up, or cursor behavior changes.

## Testing

Host tests cover local authorization, operation-set validation, grant use against `address`, and the unchanged native `begin` path failing closed without a seed. The typed client gateway test covers automatic authorization, grant propagation on every queue operation, separate local/direct cursors, revocation, and failure rollback. Component tests cover channel switching, per-channel acknowledgement, same-workspace/direct/broadcast sends, the generated names, and the authorization-failure fallback. The assembled built-client snapshot (`apps/web/tests/agent-mail-local.snapshot.ts`) opens the Agent Mail tab in the real browser composition and requires both channels and a Send control with no native-code prompt.
