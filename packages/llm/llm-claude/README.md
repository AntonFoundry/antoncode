---
description: "English"
kind: "package-reference"
---

# `@deepseek-ai/dsh-llm-claude`

English

## Summary

English

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)

## Understand the implementation

English

This provider registers `claude-code` on `ctx.llm`: Claude models over the Anthropic Messages API authenticated with the operator's Claude Code subscription OAuth session (browser login, approved once, refreshed silently). Transport reuses pi-ai's Anthropic implementation wholesale — it already sends Claude Code identity (`Bearer` plus the `oauth-2025-04-20` beta) for `sk-ant-oat` tokens — so this package owns only auth, routing, and capability surface: no wire code, no message translation. Returned tool calls execute through Harness tools, never through the Claude Code agent loop.

Without a session the route fails `MISSING_CREDENTIAL` naming the login fix (`dsh claude-login`); gateway rejections keep their code and gain the same guidance in the message. A keyed `anthropic` route (pi-ai profile with `ANTHROPIC_API_KEY`) stays the path for API billing; the two routes never share credentials.

The `llm-claude:` settings section accepts `oauthRef`, `displayName`, `baseURL`, `defaultContextWindow`, `streamIdleTimeoutMs`, and `retryPolicy`. `baseURL` repoints the catalog models at a compatible gateway (and at scripted ones in tests); omitted, models keep their catalog endpoints. Connection facts resolve for each request so a login reaches the very next turn without restarting Harness.

OAuth mechanics (PKCE S256, manual code paste-back, token and refresh shapes, scopes, beta header) follow the Claude Code CLI's login as observed on the wire; the implementation here is original code over those protocol facts.

## Model Experience

Subscription turns send the Harness system text, message history, and tool schemas to the Anthropic gateway with the workspace bearer; pi-ai's Anthropic transport handles protocol, effort, and tool-call translation exactly as on a keyed route. Past tool traffic serializes per the shared translator. No new model-visible text is added by the plugin.

#### KV Cache effect

Turns resend the complete request prefix on each call; cache reuse depends on the Anthropic gateway.

## Known Limitations and Deferred Work

- Subscription-only: this route cannot serve API keys (use the `anthropic` pi-ai route for `ANTHROPIC_API_KEY` billing) and has no anonymous tier — every turn needs a stored session.
- Login runs from the terminal (`dsh claude-login`) or the Models-page Log in button (same paste-back flow server-side, no polling); the row dot and logout toggle follow the stored session.
- Token family detection (`sk-ant-oat`) lives in pi-ai's Anthropic implementation; a subscription token presented through any other route depends on that route's own auth vocabulary.

## Dev Note

- See the module JSDoc for the owning contract and its rationale.
