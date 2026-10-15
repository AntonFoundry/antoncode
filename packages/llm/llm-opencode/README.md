# `@deepseek-ai/dsh-llm-opencode`

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
`displayName`, `apiKeyEnv`, `zenBaseURL`, `catalogURL`, `catalogRefreshMs`,
`maxTokens`, `defaultContextWindow`, `requestTimeoutMs`, and `retryPolicy`.
Set `autoStart: false` to require a separately running service. Connection
facts resolve for each request so restarting the OpenCode service does not
require restarting Harness. The direct catalog refreshes at mount and on
`catalogRefreshMs` (eight hours by default); a failed refresh keeps the
last good snapshot.

## Model Experience

Keyed turns send the Harness system text, message history, and tool schemas
to Zen over chat-completions or Responses per the catalog protocol, with
the selected effort passed through verbatim. Anonymous turns send the
Harness system text and complete message history as a text prompt to
OpenCode's transient generator. Past tool traffic is quoted in that prompt;
no new model-visible text is added by the plugin. The generator returns
text only, so the service path emits no tool calls or separate reasoning
blocks.

#### KV Cache effect

Keyed turns resend the complete request prefix on each call; cache reuse
depends on the Zen gateway. Anonymous turns resend the complete text
history on each call; cache reuse depends on the OpenCode service and
selected model.

## Known Limitations and Deferred Work

- The transient generation API accepts text, not Harness tool schemas or image attachments. Anonymous turns can answer chat but cannot drive Harness coding tools through structured tool calls; store a Zen key for tool-capable turns.
- Anonymous direct requests currently receive the gateway's free-tier rejection (`FreeTierError`); the service path exists precisely because only genuine OpenCode network stacks pass it today.
- Automatic startup searches `PATH`, `~/.opencode/bin`, and the usual Homebrew executable locations; `OPENCODE_EXECUTABLE` can name another path. If the CLI is absent, start the service separately or configure a reachable `serverURL`. The provider does not stop the service.
