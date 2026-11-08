---
kind: upgrade-guide
description: "Agent Mail replaces global channel helpers and injected mailbox props with a registered composer store and owner-only watched resources."
---

# Agent Mail uses registered recipient state and watched resources

## Change

Custom Client integrations lose the public `agentMailChannel`, `setAgentMailChannel`, and `subscribeAgentMailChannel` helpers. `createAgentMailComposerStore` replaces their process-global state with renderer-owned Session interaction state. The picker and Reply share that state with the resident composer; selecting or replying does not replace draft text.

`AgentMailConversationViewProps` no longer accepts a Gateway for component-owned subscriptions. The view receives framework resource/store hooks and injected command callbacks. The `agentmail` resource uses the generated owner-only `agentMail.watch` stream and reconnect supervisor instead of component polling. Shared viewers cannot use Agent Mail endpoints. Stable authority failures include `agent-mail/owner-required` and `agent-mail/address-changed`.

`AgentMailGateway` adds `source(sessionId)` and `dispose()`. `authorize` and `refresh` accept an optional `AbortSignal`. `revoke` clears browser data idempotently, including unopened mailboxes; it does not alter Host permissions or durable queues. Session logs and queue storage require no migration. The earlier [delivery-outcome migration](../agent-mail-delivery/guide.md) still applies.

## Migration

1. Remove imports of the three global channel helpers. Create one composer-store handle during plugin application, declare it on the view registration, and use its actions and `useStore` in render code. Do not create independent stores or call the handle's `.create()` in production business code.
2. Read that same handle from apply-world composer or event callbacks through `ctx.slots.getStoreSnapshot`, using the current Session binding. Do not capture a render-time selection for later submission. Preserve exact Session/workspace/transport recipient tuples and revalidate them against current authorized discovery before committing one channel's recipients.
3. Replace Gateway props with the [resource-derived view props and command callbacks](../../../../packages/client/ui-conversation-agent-mail/src/client/AgentMailConversationView.tsx). Provide stable aggregate sources and disposal in custom Gateways; forward optional read cancellation. Register the resource through the framework and pair the Client with a Host/generated API containing `agentMail.watch`; do not use queue broadcast subscription as a watch or add manual polling fallback.
4. Preserve current-authority failure handling: clear sensitive cached mail before reporting denied or changed-address failures. Retain committed receipts when refresh fails, and release resource watches and reads on teardown. Verify workspace/Session selection, unchanged draft on Reply, stale-target refusal, automatic incoming updates without acknowledgement or wake-up, and reconnect without obsolete results replacing current mail.
