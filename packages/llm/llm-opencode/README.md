---
description: "OpenCode model generation through the local service or direct Zen transports."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-opencode

English

## Summary

Set `transport: service` on the `llm-opencode` profile entry to reuse the running OpenCode service and its saved login. Anton reads the local service registration and Basic password; OpenCode owns the hosted OAuth credentials and refresh. This mode bypasses direct gateway credentials, direct catalog polling, and anonymous gateway fallback. No additional Harness login or Console key is needed.

## Use this package

The service generates text through `/api/session/:id/generate`. Offered Harness tools are included as text schemas; fenced calls return to the Harness tool executor, and their results are included in the next request. OpenCode's agent loop and tools are not invoked. Image attachments are rejected because this service endpoint accepts text. `transport: auto`, the default, retains credential-based routing.

For tool-capable service use, copy [the backend agent](examples/anton-harness.md) to `~/.config/opencode/agents/anton-harness.md` and [the companion plugin](examples/anton-harness.ts) to `~/.config/opencode/plugins/anton-harness.ts`, then set `agent: anton-harness` alongside `transport: service`. The companion appends Harness delegation instructions for that agent and sets `tool_choice: none` on its transient-generation HTTP requests. Native declarations remain present, but the model requests Harness tools through fenced text, which the adapter parses and the Harness executes. OpenCode transient generation returns only text and discards native tool calls; without the companion, a native call can appear as an empty response or an introductory sentence. Other agents and primary, title, and compaction requests keep their normal behavior.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Understand the implementation

This provider registers `opencode-free` on `ctx.llm`: one route over three transports, picked per request. A logged-in Zen workspace session (device-flow OAuth via `dsh opencode-login` or the Models-page Log in button, approved once in the browser and stored as JSON in the credentials seam under `OPENCODE_ZEN_OAUTH` with silent refresh) selects the direct inference gateway at `https://opencode.ai/inference/openai/v1` with workspace identity (workspace discovery, paid models, and zero-cost turns where the gateway admits this client); zero-cost turns additionally take the free-tier gate (client-identity headers, a fixed marker with flattened history, and a fenced text tool protocol parsed back into Harness tool calls). A stored Zen bearer key (`OPENCODE_API_KEY` by default, resolved per request through the credential seam or the environment) selects direct OpenCode Zen generation — the models.dev `opencode` free tier over `https://opencode.ai/zen/v1` with the Harness's own tool schemas, so returned tool calls come back to the Harness and execute through Harness tools, never through OpenCode's local agent loop. Without either, the route serves the user's own OpenCode service (discovered from `OPENCODE_SERVER_URL`, the CLI state-home `service.json`, or live `opencode service status`, auto-started by default; Basic password from its registration file with `OPENCODE_SERVER_PASSWORD` as fallback) through transient text generation. When no service is reachable either, the request falls through to anonymous direct and surfaces the gateway's real verdict instead of a misleading transport error. No Zen API key is required for the service path.

Direct requests carry OpenCode's client identity with real Harness identifiers: `x-opencode-session-id` always, plus `x-opencode-session`, `x-opencode-request` (the latest user message id), `x-opencode-client`, and an `opencode/harness` User-Agent. The service lists zero-cost models; the Harness model picker exposes each advertised reasoning variant, including `xhigh` as Extra High. On direct, model facts come from the models.dev `opencode` catalog: exact advertised effort values with no forced default, and per-model wire protocol (Muse Spark serves Responses only; chat-completions for it is a hard 500).

Generation uses `POST /api/session/:id/generate` on the service path. The Harness owns its agent turn and does not invoke OpenCode's `/prompt` agent loop. A service without transient generation fails rather than silently switching to OpenCode tool execution. A missing service leaves the model list empty until discovery succeeds; an incorrect service password produces `AUTH`.

The `llm-opencode:` settings section accepts `transport`, `agent`, `serverURL`, `username`, `serviceFile`, `passwordFile`, `passwordEnv`, `autoStart`, `directory`, `displayName`, `apiKeyEnv`, `oauthRef`, `zenBaseURL`, `inferenceBaseURL`, `catalogURL`, `catalogRefreshMs`, `maxTokens`, `defaultContextWindow`, `requestTimeoutMs`, and `retryPolicy`. Set `autoStart: false` to require a separately running service. Connection facts resolve for each request so restarting the OpenCode service does not require restarting Harness. The direct catalog refreshes at mount and on `catalogRefreshMs` (eight hours by default); a failed refresh keeps the last good snapshot.

Authentication failures on this route name their fix in the failed turn: anonymous rejections point at login (`dsh opencode-login` or the Models-page button), a rejected workspace session at re-running it, and a rejected bearer key at the stored key or login. UI-driven login runs the same device flow server-side (`ZenLoginFlow`, provided as `ctx.opencodeOAuth`) and persists through the credentials seam — the CLI stays for headless use.

## Model Experience

### Direct and service requests

#### What the model sees

Keyed direct requests carry Harness system text, history, and tool definitions through the catalog-selected chat-completions or Responses protocol. Service requests carry system text, complete history, and offered tools as a text prompt to `/api/session/:id/generate`; past tool traffic is quoted. The configured companion adds backend delegation guidance and disables native tool selection so fenced calls return to the Harness executor. Zero-cost OAuth requests use the fixed developer marker and flattened user history in [`src/zen-gate.ts`](src/zen-gate.ts), with tool definitions appended as a fenced text protocol; title and compaction requests skip that tool protocol.

#### Token effect

Text-mode tool definitions and quoted historical tool traffic consume prompt tokens as ordinary text. A complete history is resent on each request; the service response does not provide separate usage or reasoning blocks. Direct responses report the usage supplied by their protocol translator.

#### KV Cache effect

Cache reuse depends on the selected Zen gateway or OpenCode service and model. Switching transports or changing the flattened history, tool protocol, or system text changes the serialized prefix and can prevent reuse.

## Known Limitations and Deferred Work

- The transient generation API accepts text rather than Harness tool schemas or image attachments. Service turns carry tool schemas through the text protocol and require the backend agent and companion described above. Image attachments are rejected.
- Live-verified 2026-10-16: the inference gateway answers `FreeTierError` to harness-runtime requests even with a valid workspace session, byte-exact client headers, catalog-correct protocol, and gate-shaped bodies on both wire protocols — only genuine OpenCode network stacks pass the client check. The local-service path therefore remains the working free path (text-only); the workspace session still owns discovery narrowing, paid-model turns, silent refresh, and exact failure guidance.
- Automatic startup searches `PATH`, `~/.opencode/bin`, and the usual Homebrew executable locations; `OPENCODE_EXECUTABLE` can name another path. If the CLI is absent, start the service separately or configure a reachable `serverURL`. The provider does not stop the service.

### Dev Note

- See the module JSDoc for the owning contract and its rationale.
