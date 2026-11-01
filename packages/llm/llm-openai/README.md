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

A profile that names no `apiKeyEnv` derives the reference per route in upper
snake — `openai` → `OPENAI_API_KEY`, `openai-compatible` →
`OPENAI_COMPATIBLE_API_KEY` — matching the web Models page's own derivation,
so a key stored there is the one the route resolves (and removal cleans up).

Environment fallbacks (trusted layers only): `OPENAI_API_KEY`,
`OPENAI_BASE_URL`. The key is never a configuration value — only its
environment-variable reference is. Route `headers` are sent with every
request; transport-owned authorization, negotiation, and Harness attribution
headers take precedence when names collide.

## Wire behavior

- **Reasoning effort** is declared per catalog model with `reasoningEfforts`;
  models without that field have no effort control. The built-in reasoning
  catalog lists `low`/`medium`/`high` for o3 and o4-mini, and
  `minimal`/`low`/`medium`/`high` for GPT-5. GPT-4o and GPT-4.1 models do not
  expose reasoning controls. Per-route `providers.<route>.models` replaces
  the shared catalog for endpoints with different model capabilities. A
  configured default applies only when the selected model declares that
  level; otherwise it is omitted. Unsupported explicit choices fail before
  sending a request. `off` omits the effort field; `max` remains a legacy
  alias for `high`.
  The OpenAI API's `none`, `minimal`, and `xhigh` values are serialized
  verbatim only when the selected model catalog lists them; OpenRouter keeps
  its own exact catalog-advertised values.
  The models.dev OpenRouter route selects the serializer's OpenRouter dialect,
  which preserves its catalog-advertised `none`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, and `max` values instead of clamping them to High, and
  spells `off` as `none`. The OpenGateway route selects the gateway dialect,
  which preserves the same documented labels but sends no field for `off`,
  matching the gateway's provider-default meaning.
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

## Known Limitations and Deferred Work

- **Text-only.** The chat-completions and Responses serializers carry no attachments, so image blocks are rejected with `UNSUPPORTED_CONTENT` rather than silently dropped. Adding vision means new wire plumbing, not a config flag.
- **Static default catalog.** The package ships a small built-in model list and never fetches one; live discovery belongs to `llm-models-dev` or a provider route that owns its own catalog.
- **No `max` on OpenAI's own API.** Harness `max` maps to `high` for the plain route; only a dialect route (`openrouter`, `gateway`) sends the label verbatim.
- **No reasoning replay.** Official responses carry no chain of thought, and history keeps visible text and tool calls only, so a resumed turn cannot resend prior reasoning.

## Development

```sh
tsc -b tsconfig.host.json        # workspace typecheck (also registers the project)
tsdown --env.DSH_BUILD_FACE host # bundles lib/index.js
vitest run packages/llm/llm-openai/tests
```
