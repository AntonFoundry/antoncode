---
description: "Discover live Sessions by workspace, reply, and follow owner-authorized Agent Mail without waking recipients."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-conversation-agent-mail

English

## Summary

Read workspace mail, cross-workspace direct messages, and parent-child `send_message` correspondence from a Session tab. Choose live recipients by workspace and Session, or use mentions, then send through the resident composer. Reply selects the sender without replacing your draft. Mail follows queue and peer changes while the tab is open; opening or refreshing it neither acknowledges mail nor wakes an Agent.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Select Agent Mail in a Session conversation. Choose a workspace, then one or more live Sessions. The picker shows available titles, deterministic display names, short addresses, and delivery transport; unavailable titles fall back to identifiers. Selecting an incompatible transport explicitly replaces the previous recipients. Direct recipients can span several remote workspaces in one atomic submission. Reply selects an exact, currently discoverable sender and focuses the existing composer without changing its text.

Mentions remain a shortcut. Explicit selections and mentions must agree; stale addresses, changed transport, and wrong-channel selections reject before publication rather than silently broadcasting. Local mail with no recipients uses workspace broadcast; direct mail requires a recipient. The composer rejects image attachments.

Live updates follow committed mail and peer changes. Refresh remains available when the displayed mailbox is stale. If publication commits but its refresh fails, the send remains successful and its outgoing row stays visible with a warning: retry refresh, not delivery. The explicit acknowledgement action advances the selected queue's processing cursor; merely viewing mail does not advance it.

-----

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Web composition mounts the Client contribution with `@deepseek-ai/dsh-agent-queue/mail-remote` and both queue owners. The generated `agentMail` Remote methods enforce owner-only access, including an explicit Host principal check. The watch observes an exact live Agent without resuming another Session. Host authorization, not the picker or browser cache, decides eligibility.

A framework-owned `agentmail` resource opens the Host watch before its initial read and follows the shared Remote reconnect supervisor. Queue observation does not create a delivery account, subscribe to workspace broadcasts, acknowledge mail, or wake an Agent. Generation-local invalidations contain revisions rather than message bodies; the resource coalesces them into paginated queries. Resource release cancels its watch and reads. Components consume `useResource` instead of maintaining subscriptions or polling.

The Gateway owns one stable aggregate source per Session and a temporary browser outbox. A committed receipt publishes before refresh completes. Authorization and request identities reject obsolete query completions. Declared authority failures clear cached mail before the resource reports failure; other declared Remote failures can retain the last authorized snapshot with a live-update warning. Unexpected defects propagate instead of being recast as authorization failures. Plugin disposal clears Gateway state.

One declared composer store holds only channel, browsed workspace, and selected recipient tuples. The renderer owns its Session instances; render code uses `useStore` and actions. Apply-world composer commands read the same handle through `getStoreSnapshot` with the current Session binding. Submission revalidates each Session, workspace, and transport tuple against current discovery without rewriting the body. Mail data stays in the resource/Gateway, not the interaction store. The [decision note](../../../.agents/notes/implemented/architecture/2026-11-08-agent-mail-resource-and-composer-ownership.md) explains this ownership split.

Both channels read the registered `agent-mail` Conversation target. Successful native and nested PTC queue settlements contribute canonical outgoing rows, never guesses from draft arguments. Inbox and outgoing copies with the same transport, sender workspace, and sequence appear once. The general channel also shows successful `send_message` settlements and admitted incoming `agent-message` text. Failed or unfinished sends, initial task prompts, and runtime settlement notices are not authored mail. Projection neither delivers mail nor appends Session events.

</details>

-----

## Further Exploration

- [Queue authorization and retention](../../interaction/agent-queue/README.md) — Host delivery owners.
- [Client resources](../../../docs/subsystems/client-resources.md) — read and watch lifecycle.
- [Client stores and slots](../../../docs/subsystems/slots.md) — registered interaction state.
- [Integration migration](../../../docs/upgrade-guide/v0.2.2-alpha.2/cross-workspace-agent-mail/guide.md) — removed globals and resource-derived props.

-----

## Model Experience

### Queue composition

#### What the model sees

The `agent-mail` composer route sends queue messages rather than ordinary Session prompts. The browser contributes no model-facing text; recipient queue tools own any later delivery into model context.

#### Token effect

No input tokens are added by opening the tab or sending a queue message. A recipient tool read has the token effects documented by the [queue tools](../../interaction/tool-agent-queue/README.md).

#### KV Cache effect

None; browser presentation does not change provider requests or their reusable prefixes.

## Known Limitations and Deferred Work

- Agent Mail is owner-only; shared viewers cannot discover peers, watch mail, send, or acknowledge through these endpoints.
- The picker offers currently live, authorized peers. It does not authorize offline direct delivery, resume recipients, or change archive policy. Local queue APIs retain their separate durable-member rules.
- Queue sends do not wake recipients or acknowledge their inboxes. Subagent `send_message` retains its separate waking/steering semantics. Reply is address selection, not persisted thread metadata or evidence that a recipient read or responded.
- Session-derived rows cover only the loaded Session window. Incoming parent-child messages appear after model admission; native outgoing calls require their loaded call head and successful result. Nested PTC settlements carry their own result. Loading older windows and replay reconstruct these rows.
- Queue-send projection requires complete canonical result JSON. Queue tools cap rendered results at 16000 characters, so truncated results are excluded even when delivery succeeded.
- The browser outbox does not survive reload or authorization reset. Queue retention and Session logs remain separate durable owners; this package supplies no permanent Sent archive.
- The shared supervisor reconnects carrier interruptions. After a terminal watch failure, Refresh updates displayed data but does not restart observation; reopen Agent Mail to reconnect live updates.
- Live updates require the matching Host watch descriptor and generated Remote API; manual polling is not a compatibility fallback. Client source edits still require the supported bundle rebuild and activation workflow.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
