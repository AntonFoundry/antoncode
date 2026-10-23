# @deepseek-ai/dsh-agent-queue

English

Host-owned durable mailbox for agents in one registered workspace. A workspace stream is addressed by `WorkspaceId`, while individual agents are addressed by their durable `SessionId` (never an activation/run id). The service validates the exact live calling Agent, its immutable header working directory through `workspaceRegistry.resolveByPath`, and filtered workspace membership before every operation. Neither knowing a session id nor supplying a different workspace id grants access.

## Service API and delivery

`ctx.agentQueue` provides:

- `identities(agent)` → `{ workspaceId, sessionId, sessionIds }` for the authorized caller and current workspace peers.
- `publish(agent, { workspaceId?, recipients?, workspaceWide?, body })` → a durable message with `id`, per-workspace `seq`, `sender`, frozen `recipients`, `workspaceWide`, `body`, and `createdAt`. Explicit recipient ids must belong to the same registered workspace; up to 32 direct recipients and 65,536 characters of body are accepted. `workspaceWide` is a topic marker: the publish operation freezes **currently opted-in** workspace subscribers into the recipients list. Future subscribers do not inherit earlier broadcasts. A topic send with no direct targets and no current subscribers rejects without consuming a sequence.
- `subscribe(agent, workspaceId?, listener?, signal?)` → a disposer for an optional live notification listener. It durably opts the session into *future* workspace broadcasts, preserving any existing direct-message cursor. Disposing the listener does not unsubscribe the durable account; `unsubscribe(agent, workspaceId?)` removes broadcast opt-in after its addressed unread messages are acknowledged, while retaining the direct cursor.
- `read(agent, { workspaceId?, cursor?, after?, limit? })` → `{ messages, cursor, hasMore }`. It returns only messages whose frozen recipients include the caller. `cursor` and `after` are exclusive stream-sequence read positions (not new acknowledgements); without either, the read starts after the durable acknowledged cursor. Explicit lower positions can replay only messages still retained. Reads are bounded to 1–100 results (default 50).
- `ack(agent, workspaceId, throughSeq)` → the caller's durable acknowledged cursor. It advances monotonically and cannot move beyond the committed workspace stream head; acknowledging another session is not supported.

Direct publication creates a durable per-recipient cursor without opting that recipient into broadcasts. A cold or resumed addressee can therefore read and acknowledge its direct mail before subscribing, or subscribe later and still read unacknowledged historical direct mail. All queue write operations serialize; per-workspace sequence, bounded-message compaction, and each new message land in one durable workspace-domain write. Live listeners receive advisory post-commit sequence notifications and can replay via `read`; publishing never injects inbox input, wakes an agent, or interrupts an inference.

## Model Experience

### Addressed mailbox data

#### What the model sees

The service itself adds no prompt text or model tool schema. A separate `@deepseek-ai/dsh-tool-agent-queue` package exposes `agent_queue_*` tools and a bounded unread notice at a later natural model step. Through those tools, an authorized agent can inspect its own workspace address, publish selected text, read addressed messages, and explicitly acknowledge processed sequences; the service never exposes sibling transcripts or another workspace's queue.

#### Token effect

No tokens are consumed merely by storing or notifying about a message. Tool calls, returned bounded message pages, and an optional natural-step digest consume tokens only when a model-facing integration actually presents them. An unread digest can recur until explicit acknowledgement; no message is inserted into an in-flight inference.

#### KV Cache effect

The host service does not alter a cached model prefix. Queue-related tool definitions are governed by the separate tool package; new tool results or a changed natural-step notice append variable suffix content and may reduce reuse of that suffix, while previously stable conversation context remains unchanged.

## Cross-workspace direct mailbox (`ctx.agentDirectQueue`)

`@deepseek-ai/dsh-agent-queue/direct` mounts a second, independent service for direct messages between agents in **different** registered workspaces. It owns the separate `agent_queue_direct` domain (version 1) and never reads or writes the workspace-scoped `agent_queue` domain above. Nothing migrates: every message inside a single workspace — direct or topic — keeps living in the v1 domain with its v1 format and cursors, and a medium that only ever held v1 mail opens as an empty direct ledger.

Scope is enforced at the send, not merely documented: an addressee that resolves to the sender's own workspace is rejected with a pointer to `agent_queue_send`, so the direct ledger can only ever contain cross-workspace mail. A mixed send with one local addressee rejects as a whole and consumes no sequence.

That domain declares no table. One global singleton record is the whole ledger: the global sequence, the canonical message log, and the recipient index with every delivery cursor. `commit` is the only writer; it runs inside the service's serialized operation chain, refuses to run reentrantly, and performs exactly one `global.set`, so a message, its new cursors, and compaction land together or not at all.

Direct messaging is session-addressed only; there is no workspace id, stream, topic, or broadcast in this API:

- `address(agent)` → `{ sessionId, workspaceId, inboxCursor, unread }` for the authorized caller.
- `send(agent, { recipients, body })` → the committed message with `id`, global `seq`, `sender`, `senderWorkspaceId`, frozen `recipients` (each `{ sessionId, workspaceId }`), `body`, and `createdAt`. Up to 32 addressees and 65,536 characters are accepted. An addressee is reachable when it is a live agent whose own lineage authorizes a registered workspace **other than the sender's**, or such a workspace's filtered member session; an unreachable or same-workspace address rejects the whole send.
- `inbox(agent, { cursor?, limit? })` → `{ messages, inboxCursor, hasMore }` containing only messages whose frozen address matches both the caller's session id **and** its current authorized workspace, after its acknowledged direct position by default (1–100 results, default 50). The field is named `inboxCursor`, never `cursor`: it is a position in the cross-workspace ledger and is unrelated to the per-workspace `cursor` returned by `read`. An explicit lower `cursor` argument replays only still-retained messages and acknowledges nothing.
- `ackInbox(agent, throughSeq)` → the caller's durable `inboxCursor`. It advances monotonically, cannot pass the committed ledger head, touches no v1 workspace cursor, and acknowledges only the caller's own inbox.

Senders and addressees are authorized by the same rule as the workspace queue — exact live Agent identity plus header-derived membership, including live subagent lineage — so knowing a session id grants nothing.

### Session moves between workspaces

An address is the pair `{ sessionId, workspaceId }` frozen at send time, and the recipient-index `workspaceId` is only the last workspace that session was addressed in. Delivery is therefore re-authorized on every read, not trusted from the index: a message reaches a caller only while the caller's **current** authorized workspace equals the workspace frozen in its address. The consequences are explicit:

- A session that moves to another workspace cannot read — or acknowledge — mail addressed to it in its former workspace. `inbox` omits it (including with an explicit replay cursor), `unread` excludes it, and `ackInbox` rejects any sequence above what the caller can currently read, so the mail is retained rather than silently retired.
- New mail is addressed to the session's current workspace and is delivered there immediately.
- A session that returns to the original workspace sees that earlier mail again, as long as it is still retained.
- Mail nobody can read any more is still bounded: it is compacted once every frozen addressee has acknowledged it, and otherwise dropped at the seven-day retention ceiling.

Every candidate ledger is verified at the single commit point before it reaches the medium: retained-message count, index size, strictly increasing sequences below the head, a nonempty addressee list, and the absence of any addressee in the sender's own workspace. That last check is what structurally keeps this ledger disjoint from the v1 workspace queue, so a local direct message can never be duplicated here.

Retention is explicitly bounded four ways: mail older than seven days is dropped; mail acknowledged by every addressee is compacted; 512 retained messages or 2,048 inbox cursors reject a new send with a `RangeError` instead of discarding unread mail; and the complete encoded ledger record is capped at 8 MiB, checked at the commit point where the final size is known. Because 512 maximum-length bodies exceed 8 MiB, the byte bound — not the message count — is the binding limit for large mail.

## Known Limitations and Deferred Work

- **Direct mail is cross-workspace only** — the direct ledger deliberately refuses an addressee in the sender's own workspace, so an agent that wants both local and remote delivery makes two calls (`agent_queue_send` and the direct send). Unifying the two surfaces behind one call is deferred.
- **Direct mail expires on a fixed schedule** — the cross-workspace mailbox drops messages older than seven days even when unacknowledged, and the ceiling is not configurable. An agent that stays parked longer than the retention window loses that mail; it is a mailbox, not an archive.
- **Direct fan-out rewrites one global record** — every send rewrites the whole direct ledger (up to 512 messages plus the recipient index, bounded at 8 MiB encoded) to keep the fan-out atomic, so send cost grows with retained backlog. Per-message storage with equivalent atomicity is deferred.
- **No cross-workspace peer discovery** — `address` reports only the caller's own address. A sender must already know a peer's durable session id; the service deliberately does not enumerate other workspaces' sessions.
- **Full backlog blocks publication** — each workspace retains at most 1,024 messages. Only messages acknowledged by every frozen addressee are compacted. If a direct target never reads or acknowledges mail, its messages can occupy the bounded backlog indefinitely; a full backlog rejects new publication with a `RangeError` rather than silently dropping unread messages. There is no expiry, administrator reclamation, or dead-recipient policy yet.
- **Bounded record is rewritten per send** — each workspace's retained messages and next sequence share one durable domain record for atomic message/sequence publication. This bounds growth but rewrites up to 1,024 messages on each send; per-message storage with equivalent atomicity is deferred.
- **Cross-table cursor creation uses rollback** — initial durable direct-recipient cursor records and the message record span separate table writes. The service serializes them and attempts rollback if publication fails, surfacing rollback failures; the backend does not provide a single cross-table transaction here.
- **Replay is retention-limited** — a caller may request an earlier explicit read cursor, but fully acknowledged messages can be compacted on a subsequent publication. This is a mailbox, not a permanent transcript archive.
- **No autonomous model interruption** — live notifications are for subscribers outside inference. A model sees messages through explicit reads or a later natural step when the tool integration is mounted; a queued message does not wake a parked agent.
