---
description: "Embed the local LangFlow editor in the Workflows tab and control its sidecar lifecycle."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-flowbuilder

English

## Summary

Open the local LangFlow editor in the Workflows tab, start or stop its server, and inspect startup failures without leaving the GUI. The tab displays the server only after readiness succeeds. Workflows created in LangFlow remain in its own database rather than synchronizing with chat-created flows.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

A slim control bar (state pill, Start/Stop, an open-in-new-window link while serving) above the LangFlow UI. First visit snapshots the sidecar state. Start shows the pill as "starting…" immediately — the underlying RPC resolves only at readiness, which can take minutes on a first run while uv downloads the LangFlow environment — and then mounts the iframe once the server answers. Stop tears the child down and returns to the stopped placeholder with the hint copy. Startup failures (launcher missing, early exit with the captured stderr tail, readiness timeout) render in the error strip and placeholder.

-----

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `dagflow` conversation view calls the typed `langflow.status`, `langflow.start`, and `langflow.stop` Remotes. The [LangFlow sidecar](../../flowbuilder/langflow-sidecar/README.md) owns process startup, readiness, and teardown; this package renders that state and embeds the serving URL.

</details>

-----

## Model Experience

### LangFlow editor

#### What the model sees

No editor content enters Session model context. The `dagflow` tab registers no model tools or prompt sections; LangFlow owns any requests made within its embedded editor.

#### Token effect

None; this package adds no model-input tokens.

#### KV Cache effect

None; browser presentation does not change provider requests or their reusable prefixes.

## Known Limitations and Deferred Work

- The tab embeds LangFlow only; it does not expose the separate chat-driven `flow.*` tools or their canvas.
- **No session sync** — flows built in LangFlow live in its own database under the sidecar workdir; bridging chat-created flows into LangFlow's REST API is deferred.
- **Single sidecar, fixed port** — one LangFlow server per app at the configured port; two browser tabs share the same server state.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
