# @deepseek-ai/dsh-client-ui-flowbuilder

English

The Workflows tab (`dagflow` entry of the conversation view slot, label "Workflows"/工作流): the local [LangFlow](https://github.com/langflow-ai/langflow) server embedded in a full-tab iframe, over the `langflow.*` wire domain. The sidecar lifecycle (spawn, health, teardown) is owned by `@deepseek-ai/dsh-langflow-sidecar`; this package renders its status and forwards the user's start/stop gestures.

## Model Experience

### LangFlow embed

#### What the user sees

A slim control bar (state pill, Start/Stop, an open-in-new-window link while serving) above the LangFlow UI. First visit snapshots the sidecar state. Start shows the pill as "starting…" immediately — the underlying RPC resolves only at readiness, which can take minutes on a first run while uv downloads the LangFlow environment — and then mounts the iframe once the server answers. Stop tears the child down and returns to the stopped placeholder with the hint copy. Startup failures (launcher missing, early exit with the captured stderr tail, readiness timeout) render in the error strip and placeholder.

#### Token effect

None: the tab injects no prompts and registers no tools; only the user-triggered `langflow.status` / `langflow.start` / `langflow.stop` RPCs cross the wire.

#### KV Cache effect

None: embed interactions are wire calls, never session-log content.

## Known Limitations and Deferred Work

- **The custom canvas is gone** — the previous editable canvas over `flow.*` was removed in the LangFlow pivot (recoverable from git history); the `flow.*` wire domain, `flowBuilder` service, and model-facing tools remain for chat-driven flows and are not reachable from this tab.
- **No session sync** — flows built in LangFlow live in its own database under the sidecar workdir; bridging chat-created flows into LangFlow's REST API is deferred.
- **Single sidecar, fixed port** — one LangFlow server per app at the configured port; two browser tabs share the same server state.
