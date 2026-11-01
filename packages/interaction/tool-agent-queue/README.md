---
description: "Model-facing tools for the shared workspace agent mailbox."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agent-queue

English

## Summary

Model-facing tools for the shared host `agentQueue` service. Every tool passes its exact calling Agent to the service; the service validates live session identity, registered workspace membership, addressed recipients, durable messages, and per-session acknowledgement cursors. The host contributes the tool names to both root and child agents.

## Table of Contents

- [Tools and delivery](#tools-and-delivery)
- [Dev Note](#dev-note)

Model-facing tools for the shared host `agentQueue` service. Every tool passes its exact calling Agent to the service; the service validates live session identity, registered workspace membership, addressed recipients, durable messages, and per-session acknowledgement cursors. The host contributes the tool names to both root and child agents.

## Tools and delivery

- `agent_queue_address` returns the calling session address, workspace id, and current workspace session ids.
- `agent_queue_subscribe` opts the session into workspace-wide broadcasts. Direct addressed messages do not require a prior topic subscription. The subscription and its cursor are durable.
- `agent_queue_send` publishes one bounded text body to up to 32 session addresses, the subscribed workspace audience (`workspace_wide`), or both. An optional `workspace_id` is validated by the host service.
- `agent_queue_read` reads at most 100 messages after the caller's acknowledged cursor by default; an explicit `cursor` permits a retained-history replay. It does not acknowledge.
- `agent_queue_ack` advances only the caller's durable cursor through a specified stream sequence after processing. It never acknowledges another session's messages.

When the prompt service is mounted, a `tool:agent-queue` section tells the model to subscribe once, read unread mail before starting new work, announce what it is taking on with a workspace broadcast, publish findings so the group shares one context, and acknowledge only after processing. The guidance is omitted when no prompt service exists; the tools remain usable.

A bounded digest of up to eight unread messages is appended to a nonempty accepted `agent/pre-step` decision at the next natural model step. It does not call `agent.inject`, interrupt the current inference, or wake an idle agent. Rejected and aborted decisions receive no digest. The digest reads but never acknowledges; it repeats at later natural steps until the agent explicitly calls `agent_queue_ack`.

## Cross-workspace direct message tools (`./direct`)

The `@deepseek-ai/dsh-tool-agent-queue/direct` entry is a separate plugin over the host `agentDirectQueue` service. Its contracts carry no workspace parameter: addressing is session-to-session **across** workspaces, and a recipient in the caller's own workspace is refused by the service in favor of `agent_queue_send`. The five `agent_queue_*` tools above are unchanged, and this entry adds no digest.

- `agent_queue_dm_address` returns the caller's own session address, its workspace id, its `inboxCursor`, its unread count, and one page of live peers with the transport that reaches each. Peers are ordered by `(workspaceId, sessionId)`; the result carries `hasMorePeers` and, only while peers remain, an opaque `nextPeerCursor`. Optional `peer_cursor` resumes a walk strictly after a previous page, and optional `peer_limit` (1–128, service default 50) sizes one page. Both are validated in the tool before the service is called — a blank or overlong cursor and an out-of-range limit are errors — and an unrecognized cursor is refused by the service rather than silently restarting the walk, so a model that follows `nextPeerCursor` to exhaustion reaches every peer instead of stopping at a hidden cap.
- `agent_queue_dm_send` sends one bounded body to 1–32 session ids in other workspaces and echoes the resolved `{ sessionId, workspaceId }` addressees. Duplicate, blank, overlong, and empty recipient lists are rejected before the service is called; the service additionally rejects a same-workspace address and any recipient that is not currently a live authorized agent.
- `agent_queue_inbox_read` reads at most 100 direct messages after the caller's `inboxCursor`; an explicit `cursor` replays retained history and acknowledges nothing. Delivery is re-checked against the caller's current workspace, so mail addressed to this session while it worked in a different workspace is not returned.
- `agent_queue_inbox_ack` advances only the caller's own `inboxCursor` after processing.

Every direct result names the position `inboxCursor`, while the workspace queue tools return `cursor`. The two are separate durable positions in separate domains: acknowledging direct mail never moves a workspace cursor, and vice versa.

## Model Experience

### Tool calls and results

#### What the model sees

The model sees five `agent_queue_*` tool schemas, plus four direct-message schemas (`agent_queue_dm_address`, `agent_queue_dm_send`, `agent_queue_inbox_read`, `agent_queue_inbox_ack`) when the `./direct` entry is mounted. Results render bounded JSON text, including session/workspace identity, send receipts, read pages, and acknowledgement cursors. Calling the queue does not make a sibling's transcript visible.

#### Token effect

The five tool definitions — and the four direct-message definitions when mounted — add a fixed schema cost while visible. Tool arguments and returned JSON add data-dependent tokens, with each rendered result capped at 16,000 characters.

#### KV Cache effect

Definitions stay prefix-stable while tool visibility is unchanged. New calls and results append context after the reusable prefix; changing the plugin's lifecycle or tool scope may change the available schemas.

### Natural-step unread digest

#### What the model sees

At an accepted nonempty step, a plugin notice lists up to eight unread queue entries with stream sequence, sender, and truncated body. It explicitly says that messages replay until `agent_queue_ack` and points to `agent_queue_read` for full contents. No notice is added to rejected or already-aborted pre-step decisions.

#### Token effect

The notice is absent when no readable messages are pending. When present, it is capped at 3,600 characters, with each body excerpt capped at 400 characters; replay consumes tokens again until acknowledgement.

#### KV Cache effect

A new digest appends step-local context and does not mutate a completed model request. Its contents can change between steps as messages arrive or acknowledgements advance, so the step suffix is not stable even when the earlier conversation prefix remains reusable.

## Known Limitations and Deferred Work

- **Not mid-inference delivery** — models observe a message only through a tool call or a later natural step. Publishing does not schedule another turn or wake the recipient.
- **At-least-once digest display** — unread entries replay until explicit acknowledgement; do not treat a notice as a delivery receipt. A rejected or cancelled proposal leaves the durable cursor unchanged.
- **Bounded preview, not the entire inbox** — the digest shows at most eight excerpts. Use `agent_queue_read` for full messages and remaining pages, then acknowledge only what was actually processed.
- **Durability and authorization belong to the service** — this package stores no messages and grants no access of its own; the host services own identity, membership, retention, and cursors. It exposes no browser Mail buffer, and the separate IMAP Mail plugin is not an agent transport.
- **A moved session leaves direct mail behind** — direct mail is addressed to a session *in a workspace*, and each such address keeps its own position. If a session is later registered in a different workspace, `agent_queue_inbox_read` and `agent_queue_inbox_ack` no longer reach mail addressed to its former workspace; that mail stays retained, with its own cursor, and is readable again if the session returns.
- **Recipients must be live** — `agent_queue_dm_send` cannot leave mail for an agent that is not currently running; the send fails rather than queueing for a future session.
- **Two surfaces for two scopes** — local recipients go through `agent_queue_send` and remote recipients through `agent_queue_dm_send`; a model addressing a peer in its own workspace with the direct tool gets an error naming the right tool rather than silent routing.
- **Direct tools have no digest, and discovery is paged and pull-only** — unread cross-workspace mail is surfaced only by an explicit `agent_queue_inbox_read` (or the `unread` count from `agent_queue_dm_address`); there is no natural-step notice. Peer discovery exposes only session id, authorized workspace id, and transport — never a working directory, header, or transcript — and reaches a complete roster only when the model walks `peer_cursor` to exhaustion; a single call is one bounded page, so a model that reads only the first page sees a partial roster by design.

## Dev Note

- The tools borrow the service's authority rather than re-deriving it: authorization for a
  cross-workspace send is decided by resolving the recipient's live workspace, so a stale
  session id cannot address a mailbox it no longer belongs to.
- Tool results report the settled durable facts (sequence numbers and cursors) rather than an
  acknowledgement of intent, so a replay can be reasoned about after a restart.
