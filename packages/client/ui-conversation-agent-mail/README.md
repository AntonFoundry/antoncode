---
description: "Read and send owner-authorized workspace and direct Agent Mail from a Session conversation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-conversation-agent-mail

English

## Summary

Read workspace mail and cross-workspace direct messages from a Session tab, discover peers, and send through the resident composer. Local messages can address selected peers or broadcast to subscribed workspace members. Opening the tab does not acknowledge messages, and queue sends do not wake an Agent or enter its model inbox.

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
- Sending does not wake recipients or acknowledge their inboxes; recipients control queue reads and acknowledgements.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
