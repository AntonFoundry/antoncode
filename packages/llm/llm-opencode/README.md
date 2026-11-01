---
description: "English"
kind: "package-reference"
---

This provider registers `opencode-free` on `ctx.llm`: one route over three transports, picked per request. A logged-in Zen workspace session (device-flow OAuth via `dsh opencode-login` or the Models-page Log in button, approved once in the browser and stored as JSON in the credentials seam under `OPENCODE_ZEN_OAUTH` with silent refresh) selects the direct inference gateway at `https://opencode.ai/inference/openai/v1` with workspace identity (workspace discovery, paid models, and zero-cost turns where the gateway admits this client); zero-cost turns additionally take the free-tier gate (client-identity headers, a fixed marker with flattened history, and a fenced text tool protocol parsed back into Harness tool calls). A stored Zen bearer key (`OPENCODE_API_KEY` by default, resolved per request through the credential seam or the environment) selects direct OpenCode Zen generation — the models.dev `opencode` free tier over `https://opencode.ai/zen/v1` with the Harness's own tool schemas, so returned tool calls come back to the Harness and execute through Harness tools, never through OpenCode's local agent loop. Without either, the route serves the user's own OpenCode service (discovered from `OPENCODE_SERVER_URL`, the CLI state-home `service.json`, or live `opencode service status`, auto-started by default; Basic password from its registration file with `OPENCODE_SERVER_PASSWORD` as fallback) through transient text generation. When no service is reachable either, the request falls through to anonymous direct and surfaces the gateway's real verdict instead of a misleading transport error. No Zen API key is required for the service path.

English

## Summary

English

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)

## Understand the implementation

English

This provider registers `opencode-free` on `ctx.llm`: one route over two
transports, picked per request. A stored Zen bearer key (`OPENCODE_API_KEY`
by default, resolved per request through the credential seam or the
environment) selects direct OpenCode Zen generation — the models.dev
`opencode` free tier over `https://opencode.ai/zen/v1` with the Harness's
own tool schemas, so returned tool calls come back to the Harness and
execute through Harness tools, never through OpenCode's local agent loop.
Without a key the route serves the user's own OpenCode service (discovered
from `OPENCODE_SERVER_URL`, the CLI state-home `service.json`, or live
`opencode service status`, auto-started by default; Basic password from its
registration file with `OPENCODE_SERVER_PASSWORD` as fallback) through
transient text generation. When no service is reachable either, the request
falls through to anonymous direct and surfaces the gateway's real verdict
instead of a misleading transport error. No Zen API key is required for the
service path.

Direct requests carry OpenCode's client identity with real Harness
identifiers: `x-opencode-session-id` always, plus `x-opencode-session`,
`x-opencode-request` (the latest user message id), `x-opencode-client`, and
an `opencode/harness` User-Agent. The service lists zero-cost models; the
Harness model picker exposes each advertised reasoning variant, including
`xhigh` as Extra High. On direct, model facts come from the models.dev
`opencode` catalog: exact advertised effort values with no forced default,
and per-model wire protocol (Muse Spark serves Responses only;
chat-completions for it is a hard 500).

Generation uses `POST /api/session/:id/generate` on the service path. The
Harness owns its agent turn and does not invoke OpenCode's `/prompt` agent
loop. A service without transient generation fails rather than silently
switching to OpenCode tool execution. A missing service leaves the model
list empty until discovery succeeds; an incorrect service password produces
`AUTH`.

The `llm-opencode:` settings section accepts `serverURL`, `username`,
`serviceFile`, `passwordFile`, `passwordEnv`, `autoStart`, `directory`,
`displayName`, `apiKeyEnv`, `oauthRef`, `zenBaseURL`, `inferenceBaseURL`, `catalogURL`, `catalogRefreshMs`,
`maxTokens`, `defaultContextWindow`, `requestTimeoutMs`, and `retryPolicy`.
Set `autoStart: false` to require a separately running service. Connection
facts resolve for each request so restarting the OpenCode service does not
require restarting Harness. The direct catalog refreshes at mount and on
`catalogRefreshMs` (eight hours by default); a failed refresh keeps the
last good snapshot.

Authentication failures on this route name their fix in the failed turn: anonymous rejections point at login (`dsh opencode-login` or the Models-page button), a rejected workspace session at re-running it, and a rejected bearer key at the stored key or login. UI-driven login runs the same device flow server-side (`ZenLoginFlow`, provided as `ctx.opencodeOAuth`) and persists through the credentials seam — the CLI stays for headless use.

## Model Experience

Keyed turns send the Harness system text, message history, and tool schemas
to Zen over chat-completions or Responses per the catalog protocol, with
the selected effort passed through verbatim. Anonymous turns send the
Harness system text and complete message history as a text prompt to
OpenCode's transient generator. Past tool traffic is quoted in that prompt;
no new model-visible text is added by the plugin. The generator returns
text only, so the service path emits no tool calls or separate reasoning
blocks.

OAuth workspace turns send the workspace bearer and billed workspace id (`x-opencode-org-id`) with the request. Zero-cost turns additionally reshape the Responses body for the free-tier gate: a fixed developer marker first, the history flattened into one user message (past tool traffic quoted, never re-executed), no native `tools` field, and the tool definitions appended to the system prompt as fenced ```tool JSON blocks; fenced calls in the reply parse back into Harness tool-call chunks for Harness-side execution. Title and compaction calls skip the text protocol and stream parsing.

#### KV Cache effect

Keyed turns resend the complete request prefix on each call; cache reuse
depends on the Zen gateway. Anonymous turns resend the complete text
history on each call; cache reuse depends on the OpenCode service and
selected model.

## Known Limitations and Deferred Work

- The transient generation API accepts text, not Harness tool schemas or image attachments. Anonymous turns can answer chat but cannot drive Harness coding tools through structured tool calls; run `dsh opencode-login` for workspace turns or store a Zen key for keyed tool-capable turns.
- Live-verified 2026-10-16: the inference gateway answers `FreeTierError` to harness-runtime requests even with a valid workspace session, byte-exact client headers, catalog-correct protocol, and gate-shaped bodies on both wire protocols — only genuine OpenCode network stacks pass the client check. The local-service path therefore remains the working free path (text-only); the workspace session still owns discovery narrowing, paid-model turns, silent refresh, and exact failure guidance.
- Automatic startup searches `PATH`, `~/.opencode/bin`, and the usual Homebrew executable locations; `OPENCODE_EXECUTABLE` can name another path. If the CLI is absent, start the service separately or configure a reachable `serverURL`. The provider does not stop the service.

## Dev Note

- See the module JSDoc for the owning contract and its rationale.
