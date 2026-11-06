# Agent Note: Zen OAuth workspace transport for the OpenCode provider

Status: implemented

## Problem

The `opencode-free` route served two transports, neither of which runs free-tier models with Harness-side tool calling: keyed direct Zen needs a bearer key most operators do not have, and anonymous direct is rejected upstream (`FreeTierError`) for every non-genuine network stack. The reference `pi-opencode-zen` recipe (MIT, duyban23) shows the missing path — a logged-in workspace session over the device flow against the inference gateway, where zero-cost models additionally require gate client-identity headers, a fixed marker with flattened history, and text-protocol tools — but the harness had no OAuth flow, no gate shaping, and no login UX.

## Decision

One route, three transports, picked per operation (`router.ts` resolves a ready adapter plus shaping flags; `index.ts` owns the plan). A stored workspace session (`OPENCODE_ZEN_OAUTH`, written by `dsh opencode-login` over the console device flow in `zen-oauth.ts`, read and silently refreshed per request) selects a per-request direct adapter on the inference gateway (`https://opencode.ai/inference/openai/v1`) carrying the workspace bearer and `x-opencode-org-id`. Zero-cost turns (catalog free-set membership) additionally take the free-tier gate (`zen-gate.ts`, adapted from the reference with attribution): gate UA/session headers, the verbatim marker as the first developer message with history flattened into one user message, native `tools` removed, tool definitions appended to the system prompt as fenced ```tool JSON, and replies parsed back into Harness tool-call chunks for Harness-side execution. Title and compaction calls skip the text protocol and stream parsing but keep gate shaping. OAuth beats a stored key; the key beats the service; the service still falls through to anonymous direct on `TRANSPORT`. A shared `transformBody` hook on the OpenAI adapter carries the Responses reshaping without forking the transport. Supersedes nothing: extends [the direct-Zen transport](2026-10-15-opencode-direct-zen-transport.md), which keeps owning the keyed/anonymous split. Auth failures keep their code and gain guidance in the message (anonymous rejections point at login, rejected sessions at re-login, rejected keys at the stored key or login), so the failed chat turn tells a new-machine operator exactly what to run.

## Alternatives considered

- **Keyed-only with an `OPENCODE_API_KEY` setup page** — leaves the free-tier audience (no key, workspace owner) on the text-only service path; rejected.
- **Service `/prompt` agent loop for free-tier tools** — executes tools server-side under server permissions, violating Harness-owns-the-turn; rejected (as before).
- **Native `tools` on free-tier turns** — the gateway drops or rejects them; the text protocol is the documented working shape; rejected.
- **Rephrasing the marker/preamble/protocol prose** — the gateway keys behavior on the marker bytes and the recipe's wording is tuned; kept verbatim with attribution.

## Consequences

Workspace turns get free-tier tool execution in Harness after one browser approval; discovery narrows by the workspace allowlist; expiry refreshes silently with request-local fallback when the stored copy cannot be rewritten. Free-tier text deltas stream live (fences may flash transiently); the durable block-end is fence-free. The `llm-openai` `ResponsesInputItem` union now admits the `developer` role the Responses API defines; nothing else constructs it.

## Live verification (2026-10-16, rebuilt app + stored session)

Discovery works through the session (allowlist-narrowed workspace models), but inference turns on free-tier models fail with upstream `FreeTierError` on both wire protocols despite a valid session, byte-exact client UA (Harness attribution suffix removed after it was caught appending), the catalog wire protocol per model (an earlier forced-Responses pass failed chat-only models with `INVALID_REQUEST`), and gate-shaped bodies. Combined with the earlier finding that genuine binaries pass anonymously while byte-identical requests from other TLS stacks fail, the discriminator sits below the HTTP layer and is not reproducible from the harness Node runtime. The service path stays the working free path (text-only); the session keeps paying for discovery, paid turns, refresh, and guidance. The `AUTH` guidance distinguishes the two verdicts: re-login for rejected sessions, client-gate honesty for `FreeTierError`.

## Testing

`zen-oauth.spec.ts` (scripted console: code issue, polling, slow-down, denial, expiry, refresh, org/config reads, full login) plus `zen-gate.spec.ts` (headers, marker, flattening, body shaping, protocol, fence parsing, stream triples) cover the new modules; `zen-oauth-transport.spec.ts` boots the plugin against a scripted inference gateway and proves identity headers, gate body shape, allowlist filtering, OAuth-over-key precedence, and silent refresh with persistence. It also proves the per-posture login guidance on `AUTH` failures; the runtime delivers these as terminal error finishes, which the agent loop raises into the chat-visible turn failure. `zen-direct.spec.ts` (fixed a missing `await` in the new `resolveTransport` test harness that made the key probe always truthy), `llm-openai`, and CLI arg specs pass unchanged.
