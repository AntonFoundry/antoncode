# Agent Note: agent reports are public in the workspace mailbox

Status: implemented

English

## Problem

Continuable subagents already had a durable mailbox and a `report` tool, but report delivery went only to the direct parent's private inbox queue. A swarm of hundreds of children therefore produced parent-private "reported:" entries while the shared workspace mailbox stayed empty. Other agents could not see what siblings had learned, so they re-read the same material and spent tokens rediscovering one context, and a report could not be answered by anyone except the parent.

## Decision

`reportFrom` publishes the report to `ctx.agentQueue` when that service is mounted. The direct parent is an explicit recipient and the message is also a workspace broadcast, so every subscribed agent sees it while the parent still cannot miss it. A composition without a mailbox keeps the previous direct-parent delivery, so the subagent package remains usable on its own. The receipt remains the stable `MessageId` the tool already returns.

A newly materialized or resumed continuable child and its live parent are best-effort subscribed to the mailbox at activation creation. Subscription is durable but never part of delegation admission: a missing queue or a membership change is logged and does not fail the child.

`dsh-tool-agent-queue` registers a `tool:agent-queue` prompt section telling agents to subscribe once, read unread mail before starting new work, announce what they are taking on with a workspace broadcast, publish findings so the group shares one context, and acknowledge only after processing. The guidance disappears when no prompt service is mounted.

Settlement notices remain a direct-parent lifecycle account: they are emitted after the child's handle is disposed, when the child is no longer an authorized mailbox sender.

## Alternatives considered

**Mirror reports (parent queue plus mailbox).** Rejected by the product choice: two visible copies would duplicate the parent's context cost and leave the private queue as the de-facto source.

**Publish with only `workspaceWide`.** Rejected: a broadcast reaches only currently subscribed agents, so a parent that never subscribed could miss its own child's report. The explicit parent recipient makes delivery unconditional.

**Auto-subscribe every session in the harness home.** Rejected: subscription is workspace-scoped and durable, and only agents that participate in a delegation tree should join its channel traffic. Parent and child enrollment at activation covers the swarm without enrolling unrelated sessions.

## Consequences

Report content becomes visible to every subscribed agent in the workspace, which is the point: one shared context instead of N private rediscoveries. The parent reads reports from the mailbox (digest or `agent_queue_read`) rather than its inbox dock; settlement notices still arrive privately. Mailbox storage grows with workspace traffic, bounded by the existing queue retention rules.

## Testing

The subagent suite covers the fallback path (no mailbox) unchanged and the new publication path through a structural mailbox double, including parent-addressed broadcast and receipt identity. Existing continuation, ownership, and settlement suites pass. The tool-agent-queue suite covers the existing tools and digest; the prompt section is additive and omitted without a prompt service.
