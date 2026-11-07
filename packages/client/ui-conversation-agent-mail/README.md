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

Select Agent Mail in a Session conversation. Choose the local or direct channel; direct messages require a recipient mention, while local messages without mentions broadcast within the workspace. The composer rejects image attachments and sends only while the Session and workspace are authorized.

-----

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client uses the generated `agentMail` Remote namespace. The Host adapter is `@deepseek-ai/dsh-agent-queue/mail-remote`, mounted alongside the local and direct queues in the Web profile. Typert resolves the addressed Session to its Agent, including a persisted Session that must be resumed. LiveShare classifies every Agent Mail endpoint as owner-only. The browser gateway keeps only presentation state and never grants access by itself.

The local channel addresses peers in the sender's workspace and can broadcast to subscribed workspace members. The direct channel addresses peers in other registered workspaces. Each channel has its own read and acknowledgement cursor. Queue sends do not wake an Agent or alter its model inbox.

The general channel also reads the registered `agent-mail` Conversation target. Successful native `send_message` call/result pairs use the shipped `agent_id` argument; successful nested PTC dispatch settlements carry their own arguments. Incoming rows use admitted `user/message` events with `agent-message` attribution, preserving the logged text blocks and sender identity. Inbox insertion and admission do not create separate rows. Failed or unfinished sends, initial task prompts, and runtime-owned `subagent-settled` notices are not represented as authored mail. The projection neither delivers messages nor creates Session events.

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
- Parent-child rows cover only the loaded Session window. Incoming messages appear after model admission, not while pending in the durable Agent inbox; outgoing native calls require their loaded call head and successful result. Older-window loading and replay reconstruct these rows from existing events.
- Browser-composed queue sends retain the existing browser-local outbox; queue history and parent-child traffic are separate delivery mechanisms. Runtime settlement notices and initial delegation prompts remain in the transcript.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
