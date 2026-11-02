# Agent Mail conversation view

This browser plugin adds an Agent Mail tab to each Session conversation. It displays workspace queue and cross-workspace direct messages, discovers live peers, and routes the resident composer to the selected mail channel. Messages remain in the durable Agent Queue services; opening the tab does not acknowledge them.

The Client uses the generated `agentMail` Remote namespace. The Host adapter is `@deepseek-ai/dsh-agent-queue/mail-remote`, mounted alongside the local and direct queues in the Web profile. Typert resolves the addressed Session to its Agent, including a persisted Session that must be resumed. LiveShare classifies every Agent Mail endpoint as owner-only. The browser gateway keeps only presentation state and never grants access by itself.

The local channel addresses peers in the sender's workspace and can broadcast to subscribed workspace members. The direct channel addresses peers in other registered workspaces. Each channel has its own read and acknowledgement cursor. Queue sends do not wake an Agent or alter its model inbox.
