---
description: "Package map for saved workflow graphs, reusable blocks, graph execution, and the LangFlow sidecar."
kind: "package-group"
---

# flowbuilder/ — Saved workflow graphs

English

## Summary

Save workflow graphs, reuse blocks, and inspect graph runs through the flowbuilder tools. The domain package defines stored records and graph validation; the service owns storage and execution, and the tool package exposes them to the model. The separate LangFlow sidecar supports the browser's embedded editor. Scripted multi-agent orchestration belongs to the [workflow group](../workflow/README.md).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Choose the record library, shared service, model-facing tools, or embedded-editor sidecar; each package README owns its configuration and limitations.

| Package | Role |
|---|---|
| [`flowbuilder-domain`](flowbuilder-domain/README.md) | Stored workflow, block, and run records with schemas and graph validation |
| [`flowbuilder-service`](flowbuilder-service/README.md) | Workflow and block storage plus saved-graph execution through `ctx.flowBuilder` |
| [`tool-flowbuilder`](tool-flowbuilder/README.md) | Model-facing tools for workflow authoring, execution, run status, and block reuse |
| [`langflow-sidecar`](langflow-sidecar/README.md) | Local LangFlow server lifecycle and readiness through `ctx.langflow` |

-----

<a id="related-documentation"></a>
## Related documentation

The subsystem reference owns shared service semantics; adjacent groups own storage, orchestration scripts, and browser presentation.

- [Flowbuilder subsystem](../../docs/subsystems/flowbuilder.md) — service methods, durable writes, and lifecycle events.
- [Storage group](../storage/README.md) — non-Session storage and domain persistence.
- [Workflow group](../workflow/README.md) — model-authored scripts for multi-agent orchestration.
- [Workflows tab](../client/ui-flowbuilder/README.md) — browser presentation of the LangFlow sidecar.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
