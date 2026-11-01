---
description: "English"
kind: "package-reference"
---

# `@deepseek-ai/dsh-llm-models-dev`

English

## Summary

English

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)

## Understand the implementation

English

This adapter registers the shipped `openrouter-free` route and discovers its zero-cost chat models from `models.dev/api.json`. OpenRouter requires an API key even for free models; the route resolves `OPENROUTER_FREE_API_KEY` by default, or the `apiKeyEnv` named in its `llm-models-dev.providers.openrouter-free` settings profile. A missing key fails `MISSING_CREDENTIAL`. The catalog refreshes at mount and on the configured interval; an existing snapshot survives a failed refresh.

For each model, `reasoning_options` determines the selectable effort values. The picker offers only explicit `effort` values, and the OpenRouter request sends the selected value verbatim, including `none`, `minimal`, `xhigh`, and `max`. A model that advertises only a reasoning toggle has no effort picker; selecting no effort lets the gateway apply its own default. Other routes can be configured under `providers`, but the shipped OpenCode Free route belongs to the [local-service adapter](../llm-opencode/README.md).

## Model Experience

The adapter sends Harness messages, system text, and tool schemas through OpenRouter's OpenAI-compatible API. It adds no model-visible prompt text. Selected effort values are recorded by the Harness request header and sent only when selected.

#### KV Cache effect

No adapter-specific cache policy; OpenRouter and the selected model decide reuse.

## Known Limitations and Deferred Work

- Catalog models that advertise reasoning as a toggle or token budget without named effort values cannot offer an effort slider through this adapter.
- The catalog can list a free model that OpenRouter later retires; request-time provider errors remain authoritative.

## Dev Note

- See the module JSDoc for the owning contract and its rationale.
