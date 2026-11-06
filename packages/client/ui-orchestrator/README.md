---
description: "Inspect visible Session runs and their task trees from the Orchestrator conversation tab."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-orchestrator

English

## Summary

Inspect visible Session runs, their parent-child relationships, and recorded task plans in an Orchestrator board. Running state takes precedence over the recency classification of inactive Sessions, and archived Sessions stay hidden. Stop an active run through its card; unsupported actions are not displayed. Chat remains the default conversation view.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Select Orchestrator from the conversation header to inspect the board. Cards use human-facing Session titles when available and fall back to Session ids. The separate [Workflows tab](../ui-flowbuilder/README.md) embeds LangFlow.

-----

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser registers only the `orchestrator` conversation view. Its inject callback supplies the existing Workspace and Session list sources through framework-bound hooks. The view derives cards whenever either source changes, excluding archived Sessions and grouping subagents under their parents. The `running` flag determines activity; non-running Sessions updated within 24 hours classify as queued, and older ones classify as done. Already-published full Controller `todos` projections provide task rows; summary payloads do not carry todo trees. The kill action acquires an operation-owned Session reference and calls `Session.cancel()`, releasing the reference after settlement. Application-level toast feedback reports acceptance or the Host denial without removing board data. The package owns no board polling timer or backend. The Web application bundle mounts it through the `ui-orchestrator` row.

</details>

-----

## Model Experience

### Session board

#### What the model sees

The `orchestrator` tab contributes no model tools, prompt sections, or Session messages. Its stop action requests cancellation through the Session controller rather than adding a prompt.

#### Token effect

None; this package adds no model-input tokens.

#### KV Cache effect

None; browser presentation does not change provider requests or their reusable prefixes.

## Known Limitations and Deferred Work

- Approve, retry, inject-note, and focus actions are not implemented or displayed. Cancellation remains subject to the Session controller’s access checks.
- Unopened Sessions may lack task rows until their full projections have been read or followed.
- Token counts, cost, wall time, and error details are not projected into run cards.
- The board is not an editable workflow canvas and provides no model-backed delegation command.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
