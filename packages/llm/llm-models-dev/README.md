---
description: "Discover free chat models from models.dev and route requests through compatible provider endpoints."
kind: "package-reference"
---

# `@deepseek-ai/dsh-llm-models-dev`

English

## Summary

Choose free chat models from the models.dev catalog without maintaining a local model list. The shipped OpenRouter Free route uses your OpenRouter credential and refreshes its catalog periodically. Named reasoning efforts follow catalog metadata; request-time availability and provider errors remain authoritative.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Understand the implementation

This adapter registers the shipped `openrouter-free` route and discovers its zero-cost chat models from `models.dev/api.json`. OpenRouter requires an API key even for free models; the route resolves `OPENROUTER_FREE_API_KEY` by default, or the `apiKeyEnv` named in its `llm-models-dev.providers.openrouter-free` settings profile. A missing key fails `MISSING_CREDENTIAL`. The catalog refreshes at mount and on the configured interval; an existing snapshot survives a failed refresh.

For each model, `reasoning_options` determines the selectable effort values. The picker offers only explicit `effort` values, and the OpenRouter request sends the selected value verbatim, including `none`, `minimal`, `xhigh`, and `max`. A model that advertises only a reasoning toggle has no effort picker; selecting no effort lets the gateway apply its own default. Other routes can be configured under `providers`, but the shipped OpenCode Free route belongs to the [local-service adapter](../llm-opencode/README.md).

## Model Experience

### Free-model request

#### What the model sees

The selected model receives Harness system text, message history, and tool definitions through the OpenAI-compatible transport. The adapter adds no prompt text; a selected catalog-advertised effort is sent as `reasoning_effort` rather than as a message.

#### Token effect

The request carries the translated conversation and tool definitions. Catalog capacity and output limits inform request defaults, while provider usage and request-time errors remain authoritative; choosing a free tier does not eliminate context limits.

#### KV Cache effect

The adapter sets no additional cache policy. The selected upstream decides prefix reuse; changing model or request prefix can invalidate it.

## Known Limitations and Deferred Work

- Catalog models that advertise reasoning as a toggle or token budget without named effort values cannot offer an effort slider through this adapter.
- The catalog can list a free model that OpenRouter later retires; request-time provider errors remain authoritative.

### Dev Note

- See the module JSDoc for the owning contract and its rationale.
