---
description: "Read and send owner-authorized workspace and direct Agent Mail from a Session conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-conversation-agent-mail

English

## Summary

Read workspace mail, cross-workspace direct messages, and ongoing parent-child `send_message` communications from a Session tab, discover peers, and send queue mail through the resident composer. Local messages can address selected peers or broadcast to subscribed workspace members. Opening the tab does not acknowledge messages, and queue sends do not wake an Agent or enter its model inbox.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Select Agent Mail in a Session conversation. Choose the local or direct channel; mention suggestions include only peers reachable through that channel. Direct messages require a recipient mention and address all selected recipients atomically; local messages without mentions broadcast within the workspace. The composer rejects image attachments and sends only while the Session and workspace are authorized. A send that commits but cannot refresh the mailbox remains successful: its outgoing row stays visible with a refresh warning, so refresh the mailbox rather than sending the message again.

-----

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client uses the generated `agentMail` Remote namespace. The Host adapter is `@deepseek-ai/dsh-agent-queue/mail-remote`, mounted alongside the local and direct queues in the Web profile. Typert resolves the addressed Session to its Agent, including a persisted Session that must be resumed. LiveShare classifies every Agent Mail endpoint as owner-only. The browser gateway keeps only presentation state and never grants access by itself.

The local channel addresses peers in the sender's workspace and can broadcast to subscribed workspace members. The direct channel addresses peers in other registered workspaces. Each channel has its own read and acknowledgement cursor. Queue sends do not wake an Agent or alter its model inbox.

Both channels read the registered `agent-mail` Conversation target. Successful native and nested PTC `agent_queue_send` and `agent_queue_dm_send` settlements contribute outgoing rows to their respective channels. Rows use the accepted result’s message identity, body, timestamp, stream sequence, sender workspace, and frozen recipients, never draft arguments. Inbox and outgoing rows with the same queue identity appear once.

The general channel additionally shows adjacent-Agent correspondence. Successful native `send_message` call/result pairs use the shipped `agent_id` argument; successful nested PTC settlements carry their own arguments. Incoming rows use admitted `user/message` events with `agent-message` attribution, preserving logged text and sender identity. Inbox insertion and admission do not create separate rows. Failed or unfinished sends, initial task prompts, and runtime-owned `subagent-settled` notices are not authored mail. The projection neither delivers messages nor creates Session events.

Browser-composed sends remain in the gateway instance’s per-Session outbox after a committed receipt; later inbox refreshes preserve those rows. A failed send rejects without recording an outgoing row. A refresh failure after a successful send retains its receipt and reports stale mailbox state separately.

</details>

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

- Agent Mail endpoints are owner-only; browser presentation state does not authorize access.
- Direct messages require at least one peer mention, and image attachments are not supported.
- Queue sends do not wake recipients or acknowledge their inboxes; recipients control queue reads and acknowledgements. Subagent `send_message` retains its separate waking/steering semantics.
- Session-derived rows cover only the loaded Session window. Incoming parent-child messages appear after model admission, not while pending in the durable Agent inbox; outgoing native calls require their loaded call head and successful result. Older-window loading and replay reconstruct these rows. Nested PTC settlements carry their own result and do not require the enclosing call result.
- Queue-send projection requires complete canonical JSON in the successful tool result. Queue tools cap rendered results at 16000 characters, so truncated results are excluded rather than reconstructed from call arguments. Queue delivery may have succeeded even when this presentation row is unavailable.
- The browser-composed outbox belongs to its gateway instance and does not survive a browser reload; durable queue messages and Session-derived rows keep their separate owners. Runtime settlement notices and initial delegation prompts remain in the transcript.
- Client source changes require rebuilding and activating the client bundle through the supported application workflow; an installed bundle does not change when a checkout source file changes.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
