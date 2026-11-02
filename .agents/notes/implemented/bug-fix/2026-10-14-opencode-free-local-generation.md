# Agent Note: OpenCode Free through local transient generation

Status: implemented

## Problem

Direct requests from Harness to OpenCode Zen return `FreeTierError` even when the request includes OpenCode-style client headers. The model picker can therefore list Muse Spark 1.3 Free while its first turn fails authentication.

## Decision

The base composition mounts `dsh-llm-opencode` as the `opencode-free` provider. It discovers the user's local OpenCode service, starts it with `opencode service start` when absent and the CLI is available, authenticates with the service's Basic password, lists its zero-cost models and advertised reasoning variants, and uses `/api/session/:id/generate` for inference. The direct Zen route is absent from the shipped models.dev provider choices. The adapter fails if transient generation is unavailable; it never falls back to `/prompt`, which would run OpenCode's own agent and tools.

## Alternatives considered

**Direct Zen requests with more client headers.** The gateway still rejects direct free-tier calls, so this leaves the selected model unusable.

**OpenCode `/prompt` as a fallback.** It runs OpenCode's agent loop and tools, conflicting with the user's Harness-owned turn and permission policy.

## Consequences

The selected free model can answer text through Harness without a Zen key while OpenCode's local service is running. The transient generation endpoint does not accept Harness tool schemas or images, so this route cannot produce structured Harness tool calls. The service's authentication and availability remain external dependencies.

## Verification

The provider tests pin the route id, High variant forwarding, Harness runtime streaming, Basic authentication failures, and refusal to invoke `/prompt` when transient generation is absent. A live Muse Spark 1.3 Free request at High through the local service answers `hi`.
