# Agent Note: registry-level tool argument validation and the JSON-Schema root contract

Status: implemented

## Problem

Only `defineTool`-built tools validated model arguments; a raw `ctx.tools.register()` definition reached `execute` with whatever the model emitted. On the affected deployment a desktop-agent session (zai `glm-5.3-flash`, ~60k-token context) repeatedly emitted degenerate tool calls — `argumentsDelta: "{}"` on the wire — for its `propose` and `chrome_open` tools. The empty arguments executed, the bridge rejected the missing `command` with an opaque `HTTP 400`, and the model retried the identical degenerate call 13 times, burning the session. The same plugins also declared `parameters` in the per-property spec style (the `defineTool` input form), which the wire carries verbatim: the model saw a tool with no `type: 'object'` root and no `required` list — a schemaless declaration that invites exactly that empty emission.

## Decision

The tools registry validates every dispatch against the registered `parameters` schema in `prepareExecution`, before the `tools/pre-execute` policy pipeline. Violations become a `ToolArgsError` final result (`invalid arguments: …`, `INVALID_ARGS`) through the same normalization and sibling-hint path as body-thrown failures, so a degenerate call costs one model-visible correction instead of an opaque downstream error — and a call that can only fail never reaches an approval `ask` or gate listener. `register()` now fails loud when `parameters` lacks the `type: 'object'` JSON-Schema root: the per-property spec is the `defineTool` input form, and a spec leaked onto the wire is the schemaless declaration described above. The desktop-tools plugin declares proper JSON-Schema roots with `required` arrays, and the bridge refreshes the profile's copy on every start.

## Alternatives considered

**Fix only the desktop plugin files.** Repairs one deployment's visible symptom; every future raw-registered plugin (MCP bridges, workspace plugins) reintroduces the opaque-failure loop with the next degenerate model emission.

**Validate inside `defineTool` only, leave raw registrations to their authors.** That was the shipped contract, and it is exactly the gap: MCP-style tools keep server-side validation, but the model still needs the harness-side refusal naming the missing properties rather than an `HTTP 400` from an unrelated transport.

**Repair malformed `parameters` at registration by compiling per-property specs.** Silent input coercion at a typed boundary contradicts the explicit-over-implicit rule and would mask the authoring mistake the loud failure names.

## Consequences

Every registered tool — first-party or plugin — gets the same dispatch-time argument net, and registrations with schemaless parameter declarations fail at load with a message naming the tool and the fix. Deployments carrying pre-contract plugin files must regenerate or fix them before mounting the new registry; the bridge rewrites its own desktop-tools copy on the next harness start. Models that emit degenerate arguments recover in one retry because the violation list names the missing properties. Keyless unit coverage pins the registration rejection, the pre-policy validation result, the untouched pre-execute listener, and the raw-tool net; the reproduced GLM emission behavior itself needs the live provider.
