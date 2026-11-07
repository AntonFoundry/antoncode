---
description: "Use a ChatGPT/Codex subscription for Harness conversations with shared OAuth login and Responses streaming."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-codex

English

## Summary

Use your ChatGPT/Codex subscription for Harness conversations without configuring an OpenAI API key. The provider reuses the Codex CLI or editor’s OAuth login and refreshes it when needed. Model discovery combines the configured catalog with the account’s Codex model cache. Text, tools, and retained images use the Responses protocol; the Harness owns tool execution.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount the plugin in a Harness composition and add `codex` to its `providers` dictionary, either in entry configuration or the `llm-codex` settings section. An empty `codex` profile is valid: authentication comes from the shared OAuth login, not a configured API key. Without that profile, the route remains dormant and available to configuration consumers.

The Codex CLI or editor owns the initial login. The provider reads its `auth.json` under the resolved Codex home, refreshes expiring credentials, and writes refreshed tokens back. A missing login reports the sign-in action rather than asking for an API key. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-codex) owns accepted settings.

## Understand the implementation

The plugin resolves request connection settings and authentication for the `codex` route. [`src/adapter.ts`](src/adapter.ts) combines configured model facts with `models_cache.json`; exact configured values take precedence over cached capacity and reasoning metadata. Missing cache data falls back to the configured catalog rather than proving account access.

[`src/serialize.ts`](src/serialize.ts) maps system text to Responses `instructions`, conversation blocks to input items, and offered tools to function definitions. User images resolve through the attachment store as `input_image` parts. Tool-result images become a following user-image item because function outputs carry text. [`src/auth.ts`](src/auth.ts) owns shared-login resolution and refresh; the stream translator returns text, reasoning, tool-call, and usage chunks to the Harness. Function-call arguments stay associated with their Responses item id, while execution and subsequent tool outputs use the separate `call_id`. Sequential and interleaved calls retain their own names and arguments; an argument or completion event without a matching opened item fails with `INVALID_RESPONSE` rather than dispatching an untrusted call.

## Model Experience

### Codex request

#### What the model sees

The selected model receives Harness system text as `instructions`, serialized conversation items, and function definitions for offered tools. Resolvable retained images are sent as `input_image` data URLs. Historical reasoning is not copied into visible message text. The adapter adds no authored system prompt and requests Responses streaming with `store: false`.

#### Token effect

Text, function definitions, and retained image input contribute to the provider’s request usage. Catalog `maxTokens` values inform Harness model metadata, but the Responses serializer does not emit an output-token-cap field; callers must not treat that metadata as a backend-enforced cap. Retained response blocks contribute to later requests according to Harness history assembly.

#### KV Cache effect

Each turn resends the serialized prefix; `store: false` is not a promise of provider KV-cache behavior. The backend decides reuse, and changes to the selected model, system text, tools, history, or image representation can change the reusable prefix.

## Known Limitations and Deferred Work

- The route requires a usable ChatGPT/Codex OAuth login and backend entitlement; it does not accept an OpenAI API key or guarantee subscription access to every discovered model.
- The local model cache is advisory and can be missing or stale. Request-time rejection remains authoritative.
- Images require the attachment reader. When it is unavailable, image blocks become the shared omitted-image placeholder; system instructions and function outputs cannot directly carry image parts.
- The Responses serializer does not send an output-token cap, even though the model metadata exposes a default `maxTokens` value.

### Dev Note

None.
