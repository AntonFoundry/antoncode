# `@deepseek-ai/dsh-llm-opengateway`

English

This provider registers `opengateway` on `ctx.llm`: one route to [OpenGateway](https://opengateway.ai)'s OpenAI-compatible gateway, authenticated with `OPENGATEWAY_API_KEY` (or the `apiKeyEnv` named in its `llm-opengateway:` settings section). Discovery reads the gateway's own `GET /models` document, so the picker lists exactly the models the account can reach — including each model's context window, output cap, and wire protocol — without a bundled catalog to keep current. A missing key fails `MISSING_CREDENTIAL` at request time and names the reference to store.

The picker offers a reasoning-effort ladder on every model of the route. The gateway documents `reasoning_effort` and maps it to the selected provider's control, but its catalog publishes no per-model effort metadata, so the route advertises one configured ladder (`reasoningEfforts`, `low`, `medium`, and `high` by default) instead of a per-model claim; which levels a model honors is gateway- and model-dependent. A selected level reaches the wire verbatim, including `max` and `xhigh`, on both protocols the route serves. An empty `reasoningEfforts` list hides the control.

Streaming is inherited from [`llm-openai`](../llm-openai/README.md): the gateway speaks chat-completions for most models and the OpenAI Responses protocol for some (its catalog's `endpoints` list decides per model). Tool calls returned by either protocol execute through Harness tools, never through a gateway-side agent loop.

The `llm-opengateway:` settings section accepts `baseURL`, `apiKeyEnv`, `displayName`, `headers`, `catalogRefreshMs`, `reasoningEfforts`, `maxTokens`, `defaultContextWindow`, `streamIdleTimeoutMs`, and `retryPolicy`. Connection facts resolve for each request, so a changed endpoint or key reaches the next turn without restarting Harness. The catalog refreshes at mount and on its interval; a failed refresh keeps serving the last good snapshot.

## Model Experience

### OpenGateway request

#### What the model sees

The adapter forwards the Harness system text, message history, and tool schemas unchanged to the selected OpenGateway model. It adds no prompt text of its own and rewrites no tool schema. A selected reasoning level changes one request field — `reasoning_effort` on chat-completions, `reasoning.effort` on Responses — and no prompt text. Gateway-advertised image input is not offered: the inherited `chat-completions` and `responses` serializers carry text only, so discovery declares `inputModalities: ['text']`.

#### Token effect

The adapter adds no tokens beyond the Harness request itself. The selected model's context window and output cap come from the gateway catalog's `context_window` and `max_output_tokens`, with the configured defaults serving models the snapshot has not seen yet.

#### KV Cache effect

Turns resend the complete request prefix on each call; the adapter sets no cache policy, and the gateway and selected model decide reuse.

### OpenGateway response

#### What the model sees

Text, reasoning, and tool-call deltas arrive as Harness stream chunks from the inherited `chat-completions` or `responses` translator, whichever protocol the model's `endpoints` entry declared.

#### Token effect

Generated tokens follow the request's `maxTokens` unless the model's catalog entry advertises a smaller cap, which then becomes the default; only loop-retained blocks affect later input.

#### KV Cache effect

Loop-retained response blocks append to the next request and preserve its earlier reusable prefix. Changing the provider or model selects a different cache domain.

## Known Limitations and Deferred Work

- The gateway catalog advertises no per-model effort vocabulary, so the picker cannot hide levels a selected model does not honor; the route offers its configured ladder on every model.
- The gateway catalog is advisory. A model it lists can still be retired or ungranted for an account; the request-time provider error remains authoritative.
- Only the OpenAI chat-completions and Responses protocols are served. A model the gateway advertises solely through the Anthropic Messages protocol stays out of the picker.
