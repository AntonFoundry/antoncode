---
description: "Package map for native Z.AI web search, web reading, repository lookup, and vision tools."
kind: "package-group"
---

# zai/ — Native Z.AI tools

English

## Summary

Search the web, read pages and GitHub repositories, and analyze images or videos through native Z.AI tools. The group provides one tool plugin that calls Z.AI over HTTPS without running an MCP server process. The package README owns credential references, tool selection, and service limitations. General external MCP connections belong to the [MCP group](../mcp/README.md).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The package supplies both remote lookup and vision tools; its configuration controls which tools are registered.

| Package | Role |
|---|---|
| [`tool-zai`](tool-zai/README.md) | Native Z.AI web, repository, image, and video tools with per-call credential resolution |

-----

<a id="related-documentation"></a>
## Related documentation

Shared tool execution and credential handling remain with their respective subsystems.

- [Tools subsystem](../../docs/subsystems/tools.md) — registration, execution, and result handling for the Z.AI tool consumer.
- [Credentials subsystem](../../docs/subsystems/credentials.md) — credential references and provider resolution.
- [MCP group](../mcp/README.md) — general external server connections and resource access.
- [Web group](../web/README.md) — provider-based web search and fetch tools.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
