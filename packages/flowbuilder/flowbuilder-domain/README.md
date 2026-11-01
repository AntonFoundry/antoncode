---
description: "flowbuilder-domain package."
kind: "package-reference"
---

# @deepseek-ai/dsh-flowbuilder-domain

## Summary

English

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)

## Understand the implementation

English

Durable vocabulary for the flowbuilder capability family: workflow definitions, block library entries, and run records as zod-validated records, the `defineDomain` spec the service opens, and the pure graph validator (`validateFlowStructure`) every save path calls.

## Model Experience

### Durable workflow state

#### What the model sees

Nothing directly. The package declares the records the flowbuilder service persists (`ctx.flowBuilder`'s flows, library, runs); the model reaches them only through the service's tools, which validate with these schemas and reject invalid graphs with `validateFlowStructure` messages.

#### Token effect

Zero. No text from this package enters any model request.

#### KV Cache effect

Independent: domain records never touch request prefixes.

## Known Limitations and Deferred Work

- **Port types are hints, not enforcement** — `FlowPortType` drives canvas rendering and executor coercion hints; values at runtime stay plain JSON data. Typed-port enforcement at connect time is deferred to the client canvas.
- **No library namespacing or versioning** — the library keys blocks by id with display-name overwrite; versioned blocks and folders are deferred until a second consumer needs them.

## Dev Note

- See the module JSDoc for the owning contract and its rationale.
