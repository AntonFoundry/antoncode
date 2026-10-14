# `@deepseek-ai/dsh-llm-opencode`

English

This provider registers `opencode-free` on `ctx.llm`. It discovers the user's OpenCode service from `OPENCODE_SERVER_URL`, the OpenCode service registration file, or `opencode service status`; if none is found, it runs `opencode service start` by default. It authenticates with the service's Basic password from its registration file or `OPENCODE_SERVER_PASSWORD`. The service lists zero-cost models; the Harness model picker exposes each advertised reasoning variant, including `xhigh` as Extra High for Muse Spark 1.3 Free. No Zen API key is required.

Generation uses `POST /api/session/:id/generate`. The Harness owns its agent turn and does not invoke OpenCode's `/prompt` agent loop. A service without transient generation fails rather than silently switching to OpenCode tool execution. A missing service leaves the model list empty until discovery succeeds; an incorrect service password produces `AUTH`.

The `llm-opencode:` settings section accepts `serverURL`, `username`, `serviceFile`, `passwordFile`, `passwordEnv`, `autoStart`, `directory`, `displayName`, `maxTokens`, `defaultContextWindow`, `requestTimeoutMs`, and `retryPolicy`. Set `autoStart: false` to require a separately running service. Connection facts resolve for each request so restarting the OpenCode service does not require restarting Harness.

## Model Experience

The adapter sends the Harness system text and complete message history as a text prompt to OpenCode's transient generator. Past tool traffic is quoted in that prompt; no new model-visible text is added by the plugin. The generator returns text only, so the adapter emits no tool calls or separate reasoning blocks.

#### KV Cache effect

The adapter resends the complete text history on each call; cache reuse depends on the OpenCode service and selected model.

## Known Limitations and Deferred Work

- The transient generation API accepts text, not Harness tool schemas or image attachments. This route can answer chat turns but cannot drive Harness coding tools through structured tool calls.
- Automatic startup searches `PATH`, `~/.opencode/bin`, and the usual Homebrew executable locations; `OPENCODE_EXECUTABLE` can name another path. If the CLI is absent, start the service separately or configure a reachable `serverURL`. The provider does not stop the service.
