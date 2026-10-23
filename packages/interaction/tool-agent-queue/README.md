# @deepseek-ai/dsh-tool-agent-queue

English

Model-facing tools for the shared host `agentQueue` service. Every tool passes its exact calling Agent to the service; the service validates live session identity, registered workspace membership, addressed recipients, durable messages, and per-session acknowledgement cursors. The host contributes the tool names to both root and child agents.

## Tools and delivery

- `agent_queue_address` returns the calling session address, workspace id, and current workspace session ids.
- `agent_queue_subscribe` opts the session into workspace-wide broadcasts. Direct addressed messages do not require a prior topic subscription. The subscription and its cursor are durable.
- `agent_queue_send` publishes one bounded text body to up to 32 session addresses, the subscribed workspace audience (`workspace_wide`), or both. An optional `workspace_id` is validated by the host service.
- `agent_queue_read` reads at most 100 messages after the caller's acknowledged cursor by default; an explicit `cursor` permits a retained-history replay. It does not acknowledge.
- `agent_queue_ack` advances only the caller's durable cursor through a specified stream sequence after processing. It never acknowledges another session's messages.

A bounded digest of up to eight unread messages is appended to a nonempty accepted `agent/pre-step` decision at the next natural model step. It does not call `agent.inject`, interrupt the current inference, or wake an idle agent. Rejected and aborted decisions receive no digest. The digest reads but never acknowledges; it repeats at later natural steps until the agent explicitly calls `agent_queue_ack`.

## Cross-workspace direct message tools (`./direct`)

The `@deepseek-ai/dsh-tool-agent-queue/direct` entry is a separate plugin over the host `agentDirectQueue` service. Its contracts carry no workspace parameter: addressing is session-to-session and may cross registered workspaces. The five `agent_queue_*` tools above are unchanged, and this entry adds no digest.

- `agent_queue_dm_address` returns the caller's own session address, its workspace id, its acknowledged position, and its unread count.
- `agent_queue_dm_send` sends one bounded body to 1–32 session ids in any workspace and echoes the resolved `{ sessionId, workspaceId }` addressees. Duplicate, blank, overlong, and empty recipient lists are rejected before the service is called.
- `agent_queue_inbox_read` reads at most 100 direct messages after the caller's acknowledged position; an explicit `cursor` replays retained history and acknowledges nothing.
- `agent_queue_inbox_ack` advances only the caller's own direct position after processing.

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
- **Direct tools have no digest and no discovery** — unread cross-workspace mail is surfaced only by an explicit `agent_queue_inbox_read` (or the `unread` count from `agent_queue_dm_address`); there is no natural-step notice, and no tool lists another workspace's session ids.
