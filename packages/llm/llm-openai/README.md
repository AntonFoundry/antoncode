---
description: "Configure OpenAI and compatible endpoints for Harness conversations over chat-completions streaming."
kind: "package-reference"
---

# dsh-llm-openai

English

## Summary

Use OpenAI or an OpenAI-compatible endpoint for Harness conversations and tools. Configure route-specific endpoints, credential references, model catalogs, and reasoning choices. Routes remain dormant until their provider profiles are present. The Harness executes returned tool calls, while the configured endpoint owns inference, availability, and usage limits.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Understand the implementation

OpenAI and OpenAI-compatible chat-completions adapter for the DeepSeek Harness LLM seam. One adapter serves profile-gated provider routes with the identical `POST {baseURL}/chat/completions` + SSE protocol:

- **`openai`** — the official OpenAI API (`https://api.openai.com/v1` by default). Model catalog: GPT-4o, GPT-4o mini, GPT-4.1, GPT-4.1 mini, o3, o4-mini, GPT-5.
- **`openai-compatible`** — any local OpenAI "installation": LM Studio, vLLM, llama.cpp, Ollama's `/v1` bridge, or a self-hosted gateway. Point `baseURL` at the local server and select models on the web Models page.

Both routes are declared in the configurable-provider directory. The shipped composition reserves `openai` in `@deepseek-ai/dsh-llm-pi-ai`, so the native adapter owns the official route and the Models page offers it while dormant.

The design mirrors `@deepseek-ai/dsh-llm-deepseek` (and, in spirit, OpenCode's `@ai-sdk/openai-compatible` choice): transport-only adapter, connection facts resolved per request, credentials through the credential seam, live settings via the `llm-openai:` settings section. Like `@deepseek-ai/dsh-llm-pi-ai`, the adapter mounts **dormant**: a route registers only while the `providers` dict names it, so the web Models page can offer, add, and delete these built-ins exactly like user-added providers.

The adapter exposes its configuration to Settings, where a provider edit reloads the entry and registers its revised routes. A dormant route stays available in the add-provider catalog.

## Configuration

```yaml
# $DSH_HOME/settings.yaml — written by the web Models page
llm-openai:
  # Section fields are the shared defaults every route falls back to.
  baseURL: https://api.openai.com/v1   # or http://127.0.0.1:1234/v1 for a local install
  maxTokens: 16384
  defaultContextWindow: 128000
  models:
    - id: gpt-4o
      name: GPT-4o
      contextWindow: 128000
      maxTokens: 16384
    - id: gpt-5
      reasoningEfforts: [minimal, low, medium, high]
  # The dict key IS the route id; its presence registers the route, its
  # absence leaves it dormant. Every field is an optional per-route override.
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY    # credential ref; default derived per route
      headers:                      # optional provider-specific HTTP headers
        X-Provider-Mode: compatible
    openai-compatible:
      baseURL: http://127.0.0.1:1234/v1
      models:                         # optional route-specific catalog
        - id: local-reasoner
          reasoningEfforts: [low, medium, high]
```

A profile that names no `apiKeyEnv` derives the reference per route in upper snake — `openai` → `OPENAI_API_KEY`, `openai-compatible` → `OPENAI_COMPATIBLE_API_KEY` — matching the web Models page's own derivation, so a key stored there is the one the route resolves (and removal cleans up).

Environment fallbacks (trusted layers only): `OPENAI_API_KEY`, `OPENAI_BASE_URL`. The key is never a configuration value — only its environment-variable reference is. Route `headers` are sent with every request; transport-owned authorization, negotiation, and Harness attribution headers take precedence when names collide.

## Wire behavior

- **Reasoning effort** is declared per catalog model with `reasoningEfforts`; models without that field have no effort control. The built-in reasoning catalog lists `low`/`medium`/`high` for o3 and o4-mini, and `minimal`/`low`/`medium`/`high` for GPT-5. GPT-4o and GPT-4.1 models do not expose reasoning controls. Per-route `providers.<route>.models` replaces the shared catalog for endpoints with different model capabilities. A configured default applies only when the selected model declares that level; otherwise it is omitted. Unsupported explicit choices fail before sending a request. `off` omits the effort field; `max` remains a legacy alias for `high`. The OpenAI API's `none`, `minimal`, and `xhigh` values are serialized verbatim only when the selected model catalog lists them; OpenRouter keeps its own exact catalog-advertised values. The models.dev OpenRouter route selects the serializer's OpenRouter dialect, which preserves its catalog-advertised `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` values instead of clamping them to High, and spells `off` as `none`. The OpenGateway route selects the gateway dialect, which preserves the same documented labels but sends no field for `off`, matching the gateway's provider-default meaning.
- **Output capping** uses `max_completion_tokens` for o-series/GPT-5 class models (which reject `max_tokens`) and `max_tokens` for everything else.
- **Reasoning streaming**: official API responses carry no CoT; reasoning blocks surface only when an OpenAI-compatible server streams `reasoning_content` (e.g. Qwen-style reasoners). History never replays reasoning — OpenAI accepts visible text and tool calls only.
- **Text-only route**: image blocks become deterministic omitted-image placeholders; the wire route does not transmit image pixels.
- **Errors** normalize to harness `LlmError` codes: `AUTH`, `RATE_LIMIT`, `QUOTA_EXCEEDED`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST`, `SERVER`, `TRANSPORT`, `TIMEOUT`, `ABORTED`.

## Model Experience

### OpenAI-compatible request

#### What the model sees

The selected model receives Harness system text, translated message history, and function definitions for offered tools. Images become deterministic omitted-image placeholders rather than visual input. The adapter adds no authored prompt text beyond this content projection. Reasoning choices become `reasoning_effort` on chat-completions rather than additional message text; historical reasoning is not replayed.

#### Token effect

The serialized conversation and function definitions consume prompt tokens. Chat-completions output uses `max_completion_tokens` for reasoning-model families and `max_tokens` otherwise. Only retained response blocks contribute to later input; provider usage remains authoritative.

#### KV Cache effect

Each request resends its serialized prefix, with no adapter-specific cache guarantee. Changing model, endpoint, system text, tool definitions, or history can change the reusable prefix; the upstream decides actual reuse.

## Known Limitations and Deferred Work

- **Text-only.** The chat-completions and Responses serializers carry no attachments. Images become deterministic omitted-image placeholders, not visual input; adding vision requires attachment translation rather than a configuration flag.
- **Static default catalog.** The package ships a small built-in model list and never fetches one; live discovery belongs to `llm-models-dev` or a provider route that owns its own catalog.
- **No `max` on OpenAI's own API.** Harness `max` maps to `high` for the plain route; only a dialect route (`openrouter`, `gateway`) sends the label verbatim.
- **No reasoning replay.** Official responses carry no chain of thought, and history keeps visible text and tool calls only, so a resumed turn cannot resend prior reasoning.

### Dev Note

- See the module JSDoc for the owning contract and its rationale.
