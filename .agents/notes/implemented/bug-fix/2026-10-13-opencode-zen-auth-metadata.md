# Agent Note: OpenCode Zen request authentication metadata

Status: implemented

## Problem

The Harness OpenCode Zen route used the right `OPENCODE_API_KEY` credential reference and bearer authorization, but omitted request identity headers that OpenCode sends to the Zen gateway. It also lacked a profile-level way to send provider-specific headers for compatible routes.

## Decision

OpenCode Zen requests carry the session id in both OpenCode session headers, use the latest assembled message id as the request id, identify the client from `OPENCODE_CLIENT`, and send an OpenCode User-Agent. The route continues to resolve `OPENCODE_API_KEY` through the Harness credentials service and sends it as a bearer token; when no key exists, its configured anonymous path supplies `public`. OpenAI-compatible route profiles can add string headers, while transport-owned headers win collisions.

The shared base bundle mounts OpenCode Free but not OpenCode Server. OpenCode Free is the configured route used by automatic summarization; the server adapter remains available as a package for profiles that explicitly choose a local OpenCode server.

## Alternatives considered

**Use a randomly generated Zen request id.** Rejected: OpenCode sends its actual user-message id, which is stable and correlates the request to the conversation event.

**Allow provider headers to override authorization and Harness-owned headers.** Rejected: a profile must not silently replace credential resolution or transport attribution.

## Consequences

Zen receives the OpenCode session/request/client fields and an OpenCode-prefixed User-Agent, and accepts route-specific gateway metadata. The project header is omitted because the Harness does not expose OpenCode's project id in the LLM request API. Anonymous OpenCode discovery follows OpenCode's zero-input-cost rule; other gateways still require explicit zero input and output costs.
