---
description: "Author, inspect, run, and reuse durable workflow graphs through model-facing tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-flowbuilder

## Summary

Let an agent save, inspect, and run reusable workflows through seven tools. The agent can search or author library blocks before composing an acyclic graph, then poll a run for its outcome. Invalid graph saves leave storage unchanged, and large JSON results are capped with an explicit truncation notice.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Understand the implementation

The model-facing `flow.*` tool family over [`ctx.flowBuilder`](../flowbuilder-service/README.md): `flow_list`, `flow_get`, `flow_save`, `flow_run`, `flow_run_status`, `flow_library_search`, and `flow_block_save`, plus the authoring-loop prompt section. This is the chat→workflow recognition path: the model authors a workflow with `flow_save`, runs it with `flow_run`, and it is stored for later retrieval. The tool confirmation still names the Dag Flow canvas; the current Workflows tab embeds the separate LangFlow editor.

Validation and rejection messages come from the service (zod durable schemas + `validateFlowStructure`), so the model sees one error vocabulary across tools, wire, and canvas.

## Model Experience

### Workflow authoring tools

#### What the model sees

The [workflow tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-flowbuilder) expose seven tools (`flow_list`, `flow_get`, `flow_save`, `flow_run`, `flow_run_status`, `flow_library_search`, `flow_block_save`) plus one prompt section teaching the authoring loop: search the library first, save small single-purpose blocks, save workflows as acyclic graphs of typed-port nodes, run with `flow_run` and poll `flow_run_status`, and tell the user the result is on the Dag Flow canvas. Rejections (invalid graph, unknown id, schema violation) arrive as tool errors with the service's message.

##### Authoring guidance

```markdown
When the user describes a repeatable multi-step workflow they want automated — or asks to save, inspect, or organize workflows — author it with the flow_* tools instead of narrating a plan: flow_save writes or updates a workflow definition (it immediately appears on the Dag Flow canvas), flow_block_save authors a reusable block into the shared library, and flow_library_search finds existing blocks to instantiate before writing new code. Keep blocks small and single-purpose; give every node a unique id and connect node ports with edges (each input port accepts one edge). When you save a workflow, tell the user it is on the Dag Flow canvas.
```

#### Token effect

The seven tool schemas and the one prompt section on every request where the preset mounts this plugin; tool results (flow graphs and library entries) enter the transcript only when the model calls the tools.

#### KV Cache effect

Tool schemas and the prompt section are stable request-prefix content; results append per call like any tool output.

## Known Limitations and Deferred Work

- **`agent` nodes need a parent session** — a run started outside an agent turn cannot execute `agent` nodes (the spawn face requires a parent); such nodes fail the run loudly.
- **Freeform graph JSON** — node and edge arguments are freeform objects validated at the service boundary; schema-level editor affordances are the canvas's job, not the tool schema's.

### Dev Note

- See the module JSDoc for the owning contract and its rationale.
