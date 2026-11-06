---
description: "Validate durable workflow definitions, reusable blocks, and run records."
kind: "package-reference"
---

# @deepseek-ai/dsh-flowbuilder-domain

## Summary

Store workflow definitions, reusable blocks, and run records with shared validation rules. Graph validation rejects duplicate ids, unresolved edges, multiple edges into one input, and cycles before a save proceeds. Runtime values remain JSON; port types do not enforce value types.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Understand the implementation

Block records expose a required `createdAt` timestamp and optional `sourceFlowId` directly. The v2 domain accepts v1 data through a storage-only decoder; reads preserve the saved file, and saves write current records. Untouched legacy records remain readable alongside current rows after the unit stamp advances. Mixed metadata representations and malformed records reject rather than losing timestamps or source flow ids. A v1 reader refuses a unit stamped v2; downgrade is unsupported.

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

### Dev Note

- See the module JSDoc for the owning contract and its rationale.
