/**
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
 *   reasoningEffort: high      # off | low | high | max (max maps to the wire's high)
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
 * - **Models**: gpt-5.3-codex, gpt-5.2-codex, gpt-5.1-codex, gpt-5.1-codex-mini,
 *   gpt-5.1-codex-max, o3, o4-mini.
 * - **Auth**: reads `~/.codex/auth.json` per request; refreshes the access
 *   token (OAuth `refresh_token` grant) when near expiry and writes the
 *   refreshed session back so the CLI/editor stay in sync. A missing login
 *   fails with a pointer to `codex login` — never a key prompt.
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
