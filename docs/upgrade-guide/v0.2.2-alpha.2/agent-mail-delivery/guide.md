---
kind: upgrade-guide
description: "AgentMailGateway sends accept batched direct recipients and return committed receipts separately from mailbox refresh errors."
---

# Agent Mail separates delivery from mailbox refresh

## Change

Custom browser integrations implementing or calling the exported `AgentMailGateway` type must update their send methods. `sendDirect` replaces `recipient: string` with `recipients: readonly string[]`, delivered in one atomic request rather than separate sends. Both `sendLocal` and `sendDirect` return `Promise<AgentMailSendOutcome>` instead of `Promise<void>`.

A successful send returns `{ receipt: { seq } }`, with optional `refreshError` when the subsequent mailbox refresh fails. The message is already committed in that case; resending can duplicate delivery. Authorization or publication failures still reject. `inbox(sessionId)` adds `sent`, the gateway instance's outgoing rows, and optional `refreshError`; these browser rows are not a durable sent-mail archive.

The resident composer's mention suggestions follow the selected channel: local peers for local mail, peers in other workspaces for direct mail. Known wrong-channel mentions reject rather than sending or falling back to a broadcast. Queue sends still do not wake recipients or submit a new turn. Host Remote methods, configuration, message attribution, and Session formats are unchanged.

## Migration

1. In consumers of `@deepseek-ai/dsh-client-ui-conversation-agent-mail/client`, replace `sendDirect({ ..., recipient, ... })` with `sendDirect({ ..., recipients: [recipient], ... })`. Submit several recipients in one call; do not loop over recipients when the send must be atomic. Follow the [Gateway declarations](../../../../packages/client/ui-conversation-agent-mail/src/client/gateway.ts) when updating custom implementations and test doubles.
2. Update both send methods to return a committed `receipt` and reserve rejection for authorization or publication failure. On `refreshError`, retry `refresh(sessionId)`, not delivery. Render persistent warnings from the current `inbox(sessionId).refreshError`; an older send outcome must not overwrite a newer successful refresh. Clear the submitted draft after a committed receipt even when its refresh failed.
3. Include `sent: []` in empty inbox snapshots. Render gateway-owned `sent` rows instead of appending another optimistic row for the same receipt. Keep that outbox browser-local; do not reconstruct a durable archive from it or carry rows across revocation and reauthorization.
4. Verify that a multi-recipient direct submission makes one Remote send. Simulate successful publication followed by refresh failure: confirm one receipt and outgoing row remain, no resend occurs, and a later successful refresh clears `refreshError`. Confirm revocation prevents older in-flight results from repopulating the mailbox. The [package reference](../../../../packages/client/ui-conversation-agent-mail/README.md) describes the supported channels and delivery limits.
