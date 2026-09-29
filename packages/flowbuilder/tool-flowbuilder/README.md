# @deepseek-ai/dsh-tool-flowbuilder

English

The model-facing `flow.*` tool family over [`ctx.flowBuilder`](../flowbuilder-service/README.md): `flow_list`, `flow_get`, `flow_save`, `flow_library_search`, and `flow_block_save`, plus the authoring-loop prompt section. This is the chat→workflow recognition path: the model authors a workflow with `flow_save`, and it appears on the Dag Flow canvas.

Validation and rejection messages come from the service (zod durable schemas + `validateFlowStructure`), so the model sees one error vocabulary across tools, wire, and canvas.

## Model Experience

### Workflow authoring tools

#### What the model sees

Five tools (`flow_list`, `flow_get`, `flow_save`, `flow_library_search`, `flow_block_save`) plus one prompt section teaching the authoring loop: search the library first, save small single-purpose blocks, save workflows as acyclic graphs of typed-port nodes, and tell the user the result is on the Dag Flow canvas. Rejections (invalid graph, unknown id, schema violation) arrive as tool errors with the service's message.

#### Token effect

The five tool schemas and the one prompt section on every request where the preset mounts this plugin; tool results (flow graphs and library entries) enter the transcript only when the model calls the tools.

#### KV Cache effect

Tool schemas and the prompt section are stable request-prefix content; results append per call like any tool output.

## Known Limitations and Deferred Work

- **No run tools yet** — `flow_run` / `flow_run_status` land with the flowbuilder execution engine (phase C of the workflow-builder plan).
- **Freeform graph JSON** — node and edge arguments are freeform objects validated at the service boundary; schema-level editor affordances are the canvas's job, not the tool schema's.
