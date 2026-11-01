---
description: "* OpenAI Codex subscription (OAuth) adapter for the DeepSeek Harness LLM seam.
 *
 * Uses your **ChatGPT/Codex subscription** — not an API key. The pl"
kind: "package-reference"
---

/**

English

## Summary

* OpenAI Codex subscription (OAuth) adapter for the DeepSeek Harness LLM seam.
 *
 * Uses your **ChatGPT/Codex subscription** — not an API key. The plugin reads
 * the OAuth login the Codex CLI or the VS Code Codex extension already holds
 * in `~/.codex/auth.json`, refreshes the access token silently through the
 * OpenAI OAuth endpoint, and talks to the Codex backend
 * (`https://chatgpt.com/backend-api/codex/responses`) with the Responses
 * protocol. There is no API-key field anywhere in the configuration — by
 * design, this provider never shows a key input box.
 *
 * ## Setup (one time)
 *
 * Log in once with the Codex CLI (`codex login`) or the VS Code Codex
 * extension. That writes/refreshes `~/.codex/auth.json`; this plugin reuses
 * it. If you have no login yet, `codex login` opens the browser flow.
 *
 * The adapter mounts **dormant**: the `codex` route registers only while the
 * `providers` dict names it, so the web Models page can offer, add, and
 * delete this built-in exactly like a user-added provider.
 *
 * ## Configuration
 *
 * ```yaml
 * # $DSH_HOME/settings.yaml — written by the web Models page
 * llm-codex:
 *   codexHome: ~/.codex        # optional; defaults to $CODEX_HOME or ~/.codex
 *   maxTokens: 32768
 *   models:
 *     - id: gpt-5.2-codex
 *       name: GPT-5.2 Codex
 *       contextWindow: 400000
 *   # The dict key IS the route id; its presence registers the route. An empty
 *   # profile is legitimate — the subscription login needs no fields.
 *   providers:
 *     codex: {}
 * ```
 *
 * Everything is included with the ChatGPT/Codex subscription — no metered
 * API billing.
 *
 * ## Wire behavior
 *
 * - **Protocol**: OpenAI Responses API (`POST {base}/responses`, SSE stream),
 *   `causal: true`, reasoning effort + auto summary, `max_output_tokens`.
 * - **Reasoning effort** comes from the Codex model catalog cached at
 *   `~/.codex/models_cache.json`. The Harness reads each model's
 *   `supported_reasoning_levels` and `default_reasoning_level`; GPT-6 Luna's
 *   current catalog offers low, medium, high, xhigh, and max, with medium as
 *   its default. When cache metadata is unavailable, the adapter keeps its
 *   legacy fallback effort set. Explicit `models[].reasoningEfforts` values
 *   override the cached list for a configured model.
 * - **Models and capacity**: the built-in list is supplemented by the models
 *   discovered from the Codex CLI's account-specific model cache. A cached
 *   `context_window` supplies discovered model capacity unless a configured
 *   exact model entry provides its own `contextWindow`.
 * - **Auth**: reads `~/.codex/auth.json` per request; sends the OAuth bearer
 *   token and `ChatGPT-Account-ID`, refreshes the token when near expiry or
 *   when the backend returns `token_expired`, and writes the refreshed session
 *   back so the CLI/editor stay in sync. A missing login fails with a pointer
 *   to `codex login` — never a key prompt.
 * - **Text-only route**: image blocks are rejected with `UNSUPPORTED_CONTENT`.
 * - **Errors** normalize to harness `LlmError` codes: `AUTH`, `RATE_LIMIT`,
 *   `QUOTA_EXCEEDED`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST`, `SERVER`,
 *   `TRANSPORT`, `TIMEOUT`, `ABORTED`.
 *
 * ## Development
 *
 * ```sh
 * tsc -b tsconfig.host.json
 * tsdown --env.DSH_BUILD_FACE host
 * vitest run packages/llm/llm-codex/tests
 * ```
 */

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)

## Understand the implementation

 * OpenAI Codex subscription (OAuth) adapter for the DeepSeek Harness LLM seam.
 *
 * Uses your **ChatGPT/Codex subscription** — not an API key. The plugin reads
 * the OAuth login the Codex CLI or the VS Code Codex extension already holds
 * in `~/.codex/auth.json`, refreshes the access token silently through the
 * OpenAI OAuth endpoint, and talks to the Codex backend
 * (`https://chatgpt.com/backend-api/codex/responses`) with the Responses
 * protocol. There is no API-key field anywhere in the configuration — by
 * design, this provider never shows a key input box.
 *
 * ## Setup (one time)
 *
 * Log in once with the Codex CLI (`codex login`) or the VS Code Codex
 * extension. That writes/refreshes `~/.codex/auth.json`; this plugin reuses
 * it. If you have no login yet, `codex login` opens the browser flow.
 *
 * The adapter mounts **dormant**: the `codex` route registers only while the
 * `providers` dict names it, so the web Models page can offer, add, and
 * delete this built-in exactly like a user-added provider.
 *
 * ## Configuration
 *
 * ```yaml
 * # $DSH_HOME/settings.yaml — written by the web Models page
 * llm-codex:
 *   codexHome: ~/.codex        # optional; defaults to $CODEX_HOME or ~/.codex
 *   maxTokens: 32768
 *   models:
 *     - id: gpt-5.2-codex
 *       name: GPT-5.2 Codex
 *       contextWindow: 400000
 *   # The dict key IS the route id; its presence registers the route. An empty
 *   # profile is legitimate — the subscription login needs no fields.
 *   providers:
 *     codex: {}
 * ```
 *
 * Everything is included with the ChatGPT/Codex subscription — no metered
 * API billing.
 *
 * ## Wire behavior
 *
 * - **Protocol**: OpenAI Responses API (`POST {base}/responses`, SSE stream),
 *   `causal: true`, reasoning effort + auto summary, `max_output_tokens`.
 * - **Reasoning effort** comes from the Codex model catalog cached at
 *   `~/.codex/models_cache.json`. The Harness reads each model's
 *   `supported_reasoning_levels` and `default_reasoning_level`; GPT-6 Luna's
 *   current catalog offers low, medium, high, xhigh, and max, with medium as
 *   its default. When cache metadata is unavailable, the adapter keeps its
 *   legacy fallback effort set. Explicit `models[].reasoningEfforts` values
 *   override the cached list for a configured model.
 * - **Models and capacity**: the built-in list is supplemented by the models
 *   discovered from the Codex CLI's account-specific model cache. A cached
 *   `context_window` supplies discovered model capacity unless a configured
 *   exact model entry provides its own `contextWindow`.
 * - **Auth**: reads `~/.codex/auth.json` per request; sends the OAuth bearer
 *   token and `ChatGPT-Account-ID`, refreshes the token when near expiry or
 *   when the backend returns `token_expired`, and writes the refreshed session
 *   back so the CLI/editor stay in sync. A missing login fails with a pointer
 *   to `codex login` — never a key prompt.
 * - **Text-only route**: image blocks are rejected with `UNSUPPORTED_CONTENT`.
 * - **Errors** normalize to harness `LlmError` codes: `AUTH`, `RATE_LIMIT`,
 *   `QUOTA_EXCEEDED`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST`, `SERVER`,
 *   `TRANSPORT`, `TIMEOUT`, `ABORTED`.
 *
 * ## Development
 *
 * ```sh
 * tsc -b tsconfig.host.json
 * tsdown --env.DSH_BUILD_FACE host
 * vitest run packages/llm/llm-codex/tests
 * ```
 */

## Dev Note

- See the module JSDoc for the owning contract and its rationale.
