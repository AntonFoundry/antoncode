---
description: "Package map for model-facing Anton runtime health and lifecycle controls over the Anton Bridge."
kind: "package-group"
---

# lifecycle/ — Anton runtime controls

English

## Summary

Inspect Anton service health and request runtime start, stop, or restart through model-facing tools. The lifecycle group exposes the Anton Bridge control API; the bridge owns process supervision outside the runtime. Stop and restart terminate the calling runtime and its current turn. The package README owns configuration and tool-specific behavior.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The group contains the tool consumer, not the supervisor implementation.

| Package | Role |
|---|---|
| [`tool-anton-lifecycle`](tool-anton-lifecycle/README.md) | Model-facing health, start, stop, and restart requests to the Anton Bridge |

-----

<a id="related-documentation"></a>
## Related documentation

Tool execution and process supervision have separate owners.

- [Tools subsystem](../../docs/subsystems/tools.md) — registration, execution, and result handling for the lifecycle tool consumer.
- [Anton Bridge](../../apps/anton-bridge/README.md) — out-of-process supervision and deployment configuration.
- [Core package group](../core/README.md) — shared tool runtime and agent services.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
