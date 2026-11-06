---
description: "Use Z.AI vision, search, page-reading, and repository tools without persistent MCP servers."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-zai

English

## Summary

Give an agent Z.AI vision, search, page-reading, and repository tools without persistent MCP server processes. The enabled tools retain the original MCP names and use HTTPS backends. Credentials resolve for each call, and an allowlist controls which tool schemas are visible.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Why this exists instead of `mcp-client` entries](#why-this-exists-instead-of-mcp-client-entries)
- [Config](#config)
- [Services consumed](#services-consumed)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Understand the implementation

Native Z.AI tools: the exact behavior of the four ZAI MCP servers (`zai-vision`, `zai-web-search`, `zai-web-reader`, `zai-read-github`) as in-process `defineTool` registrations — thirteen model-facing tools, zero server processes, zero ports.

## Why this exists instead of `mcp-client` entries

Each bridged MCP server costs a live connection plus supervisor state, and each `stdio` one costs a child process. These tools' backends are plain HTTPS, so the plugin calls them directly:

- The remote trio (`web_search_prime`, `webReader`, `search_doc`, `read_file`, `get_repo_structure`) reuses the MCP Streamable HTTP endpoints through a short-lived per-call session (initialize → `tools/call`); nothing persists between calls.
- The eight vision tools call the same `chat/completions` endpoint `@z_ai/mcp-server` calls, with its verbatim system prompts (`src/prompts.ts`, vendored from the Apache-2.0 npm distribution) and its file handling (URLs pass through, local images become data URLs, 5 MB image / 8 MB video caps, jpg/jpeg/png and mp4/mov/m4v only).

## Config

| Field | Default | Description |
|---|---|---|
| `apiKeyEnv` | `Z_AI_API_KEY` | Credential reference naming the Z.AI key. Resolved per tool call through `ctx.credentials` with launching-environment fallback — a rotated key takes effect on the next call, no restart. Never a literal key. |
| `visionModel` | `glm-5.3-flash` | Vision chat model, as in `@z_ai/mcp-server`. |
| `timeoutMs` | `300000` | Per-call HTTP timeout in milliseconds. |
| `enabledTools` | all thirteen | Allowlist; unknown names fail loud at load. |

One plugin instance registers the enabled tools under their plain MCP names (`web_search_prime`, `webReader`, …) — no `mcp__` namespacing, since there is exactly one owner. The Plugins settings card (one card, one key field, per-tool toggles) binds this plugin's settings namespace.

## Services consumed

| Service | Usage |
|---|---|
| `ctx.tools` | Register the thirteen tools |
| `ctx.credentials` | Resolve `apiKeyEnv` per call (optional; ambient environment otherwise) |

## Model Experience

### Request context and condition

#### What the model sees

The [Z.AI tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-zai) expose thirteen native tools with the MCP originals' names, descriptions, and parameter fields; results arrive as text (remote-trio blocks joined with newlines, vision message content verbatim).

#### Token effect

Per-call schemas only while registered; disabling a tool via `enabledTools` removes its schema from every request.

#### KV Cache effect

Prefix-stable while the enabled set and schemas are unchanged.

## Known Limitations and Deferred Work

- **Per-call MCP sessions cost one extra round trip** — each remote-trio call pays initialize + `tools/call` instead of sharing a persistent session's handshake.
- **Z.AI quota errors surface as tool failures** — exhausted plan quota (e.g. code 1310) throws like any backend error; the plugin does not distinguish billing from breakage.
- **No image persistence** — vision results are text; image blocks never enter `ctx.attachments`, unlike the MCP bridge path.

### Dev Note

- See the module JSDoc for the owning contract and its rationale.
