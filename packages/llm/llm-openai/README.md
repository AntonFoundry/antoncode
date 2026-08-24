# dsh-llm-openai

OpenAI and OpenAI-compatible chat-completions adapter for the DeepSeek Harness
LLM seam. One adapter serves profile-gated provider routes with the identical
`POST {baseURL}/chat/completions` + SSE protocol:

- **`openai`** — the official OpenAI API (`https://api.openai.com/v1` by
  default). Model catalog: GPT-4o, GPT-4o mini, GPT-4.1, GPT-4.1 mini, o3,
  o4-mini, GPT-5.
- **`openai-compatible`** — any local OpenAI "installation": LM Studio, vLLM,
  llama.cpp, Ollama's `/v1` bridge, or a self-hosted gateway. Point
  `baseURL` at the local server and select models on the web Models page.

The design mirrors `@deepseek-ai/dsh-llm-deepseek` (and, in spirit, OpenCode's
`@ai-sdk/openai-compatible` choice): transport-only adapter, connection facts
resolved per request, credentials through the credential seam, live settings
via the `llm-openai:` settings section. Like `@deepseek-ai/dsh-llm-pi-ai`, the
adapter mounts **dormant**: a route registers only while the `providers` dict
names it, so the web Models page can offer, add, and delete these built-ins
exactly like user-added providers.

## Configuration

```yaml
# $DSH_HOME/settings.yaml — written by the web Models page
llm-openai:
  # Section fields are the shared defaults every route falls back to.
  baseURL: https://api.openai.com/v1   # or http://127.0.0.1:1234/v1 for a local install
  reasoningEffort: high            # off | low | high | max (max maps to the wire's high)
  maxTokens: 16384
  defaultContextWindow: 128000
  models:
    - id: gpt-4o
      name: GPT-4o
      contextWindow: 128000
      maxTokens: 16384
  # The dict key IS the route id; its presence registers the route, its
  # absence leaves it dormant. Every field is an optional per-route override.
  providers:
    openai:
      apiKeyEnv: OPENAI_API_KEY    # credential ref; default derived per route
    openai-compatible:
      baseURL: http://127.0.0.1:1234/v1
```

A profile that names no `apiKeyEnv` derives the reference per route in upper
snake — `openai` → `OPENAI_API_KEY`, `openai-compatible` →
`OPENAI_COMPATIBLE_API_KEY` — matching the web Models page's own derivation,
so a key stored there is the one the route resolves (and removal cleans up).

Environment fallbacks (trusted layers only): `OPENAI_API_KEY`,
`OPENAI_BASE_URL`. The key is never a configuration value — only its
environment-variable reference is.

## Wire behavior

- **Reasoning effort** maps the harness vocabulary onto OpenAI's:
  `off` → omitted, `low` → `low`, `high` → `high`, `max` → `high` (OpenAI has
  no "max" level).
- **Output capping** uses `max_completion_tokens` for o-series/GPT-5 class
  models (which reject `max_tokens`) and `max_tokens` for everything else.
- **Reasoning streaming**: official API responses carry no CoT; reasoning
  blocks surface only when an OpenAI-compatible server streams
  `reasoning_content` (e.g. Qwen-style reasoners). History never replays
  reasoning — OpenAI accepts visible text and tool calls only.
- **Text-only route**: image blocks are rejected with `UNSUPPORTED_CONTENT`
  (matching the deepseek adapter; the wire route has no attachment plumbing).
- **Errors** normalize to harness `LlmError` codes: `AUTH`, `RATE_LIMIT`,
  `QUOTA_EXCEEDED`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST`, `SERVER`,
  `TRANSPORT`, `TIMEOUT`, `ABORTED`.

## Development

```sh
tsc -b tsconfig.host.json        # workspace typecheck (also registers the project)
tsdown --env.DSH_BUILD_FACE host # bundles lib/index.js
vitest run packages/llm/llm-openai/tests
```
