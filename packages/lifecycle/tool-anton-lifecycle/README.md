# @deepseek-ai/dsh-tool-anton-lifecycle

English | [中文](README.zh.md)

Model-facing lifecycle controls for an Anton deployment. The plugin registers `anton_status`, `anton_start`, `anton_stop`, and `anton_restart`; each makes a bounded HTTP request to the out-of-process Anton Bridge supervisor.

## What it does

The bridge owns the harness child process and the local c0ntext engine. This package does not spawn or supervise either service itself. `anton_status` reports health, `anton_start` starts the runtime, and `anton_stop` / `anton_restart` ask the supervisor to terminate the current runtime process. Stop and restart intentionally end the current model turn when the bridge carries them out; a rendered result normally means the request was refused or the bridge became unreachable.

The endpoint defaults to `http://127.0.0.1:3742`. `bridgeEndpointEnv` defaults to `ANTON_BRIDGE_ENDPOINT`, and a non-empty environment value overrides `bridgeEndpoint`. Registration fails loudly for a non-HTTP(S) endpoint. Each tool has its own timeout and propagates the caller's cancellation signal.

## Configuration

All fields are optional and default to the bundled Anton deployment:

```yaml
- id: tool-anton-lifecycle
  name: '@deepseek-ai/dsh-tool-anton-lifecycle'
  config:
    bridgeEndpoint: http://127.0.0.1:3742
    bridgeEndpointEnv: ANTON_BRIDGE_ENDPOINT
    statusToolEnabled: true
    startToolEnabled: true
    stopToolEnabled: true
    restartToolEnabled: true
```

Disable individual tools with the corresponding `*ToolEnabled: false` flag. Keep stop and restart disabled in deployments where the model must not control the supervisor.

## Export shape

This is a named function plugin exporting `name`, `inject`, `Config`, and `apply`; it intentionally has no default export. The package also owns an `./invariant` companion for package registration.

## Model Experience

### Tool schema

#### What the model sees

The four tool schemas and model-facing descriptions are generated in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-anton-lifecycle). The tools take no arguments and return the bridge's structured JSON payload.

#### Token effect

Each visible tool contributes a fixed, small schema cost to requests. Disabling unused lifecycle tools removes their schemas from the model-facing surface.

#### KV Cache effect

The schema prefix remains stable while endpoint and enablement policy are unchanged. Changing enabled tools or descriptions changes the visible tool prefix and may reduce cache reuse.

### Tool-call history and result

#### What the model sees

Successful status/start calls return the bridge's JSON result. Stop/restart may terminate the caller before a result can be rendered; refusal, timeout, or an unreachable bridge produces an explicit diagnostic rather than a false success.

#### Token effect

History grows with each tool call and the compact JSON response. Stop/restart normally add no completed result because the runtime process exits as requested.

#### KV Cache effect

Tool calls append after the stable request prefix. A restart creates a new runtime and therefore a new session/cache boundary.

## Known Limitations and Deferred Work

- The plugin requires the Anton Bridge to be running and reachable; it is not a general remote process manager.
- The bundled c0ntext engine still requires a compatible Docker/Compose runtime when the Anton Bridge is configured to start it. The lifecycle tools report that dependency's failure but do not install Docker or container images.
- Stop and restart are self-terminating operations. They cannot provide a normal post-action result to the process they terminate; use `anton_status` after the application is available again.
