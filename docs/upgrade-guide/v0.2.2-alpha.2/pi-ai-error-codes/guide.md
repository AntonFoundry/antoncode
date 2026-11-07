---
kind: upgrade-guide
description: "Pi-ai preserves structured provider failure facts and identifies overload and model availability without parsing their display messages."
---

# Pi-ai provider failure classification

## Change

The `openai-completions`, `openai-responses`, and `anthropic-messages` protocols preserve observed HTTP status, valid Retry-After delay, and request ID in terminal failures. Explicit provider codes and types identify exhausted quota as `QUOTA`, overload as `OVERLOADED`, and unavailable models as `MODEL_UNAVAILABLE`, instead of relying only on pi-ai's flattened error messages. Authentication and context rejection take precedence; explicit invalid requests remain excluded from availability classification. These facts do not themselves enable retries or fallback routes.

Structured OpenAI `response.failed` events and complete Anthropic JSON error envelopes are supported. Raw OpenAI SSE `error` events can remain `PI_AI_ERROR` because the SDK consumes their structured data before the observer. Other catalog protocols retain existing string-only classification. Original SDK HTTP errors and causes remain unavailable; captured fetch transport errors preserve their cause in a thrown `LlmError`.

## Migration

1. In custom consumers of `ctx.llm.stream()` or `agent/request-error`, handle `failure.code` values `OVERLOADED` and `MODEL_UNAVAILABLE` where you previously depended on generic `SERVER` or `PI_AI_ERROR` outcomes. Continue handling `QUOTA`, `AUTH`, `CONTEXT_WINDOW_EXCEEDED`, and `INVALID_REQUEST` separately.
2. Read `failure.status`, `failure.providerRetryAfterMs`, and `failure.requestId` when present rather than extracting these facts from display text. Do not assume all protocols or SSE failures expose them, or interpret unclassified errors as model unavailability.
3. Confirm using local provider fixtures that structured overload and model rejection produce their corresponding codes while authentication and invalid requests do not enter availability recovery. No configuration or stored Session migration is required.
