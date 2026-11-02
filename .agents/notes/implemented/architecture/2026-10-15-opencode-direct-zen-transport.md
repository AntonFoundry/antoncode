# Agent Note: Native direct-Zen transport for the OpenCode provider

Status: implemented

## Problem

The `opencode-free` route only served the local OpenCode service's
transient text generator: Harness tool schemas never crossed, so the route
could answer chat but never drive Harness tools — while the direct Zen
gateway path (the models.dev `opencode` free tier over OpenAI-compatible
chat-completions/Responses with Harness tools) had no Harness implementation.
Anonymous direct requests fail upstream (`FreeTierError`, proven to reject
even fully genuine-shaped requests from non-OpenCode TLS stacks, including
the exact embedded Bun runtime version), and the local `/generate` route is
text-only by its own OpenAPI contract, so neither path alone serves every
deployment.

## Decision

One route, two transports, picked per request inside `llm-opencode`
(`router.ts`): a stored `OPENCODE_API_KEY` selects direct Zen generation
with the Harness's own tool schemas (returned tool calls execute through
Harness tools; OpenCode's `/prompt` agent loop is never invoked); without
a key the route serves the local service transient generator (unchanged
behavior); with neither, anonymous direct surfaces the gateway's real
verdict instead of masking it as a transport error. Direct discovery,
efforts (verbatim catalog values, no forced default), and per-model wire
protocol ride the shared `ModelsDevCatalog`/`ModelsDevAdapter` machinery;
Zen client identity (`x-opencode-session-id` always, plus session, request,
client, and an honest `opencode/harness` User-Agent with real Harness ids)
lives in `zen.ts`. Only genuine OpenCode network stacks pass the anonymous
free-tier gate today, so anonymous turns stay on the service path.

## Alternatives considered

- **Direct-only with `public` fallback** — regresses today's working
  anonymous text path into a guaranteed upstream rejection.
- **Service `/prompt` agent loop for tools** — executes tools server-side
  under server permissions, violating Harness-owns-the-turn; rejected.
- **Separate `opencode-server` route** — duplicates the picker entry for a
  transport detail; rejected in favor of per-request routing.

## Consequences

Keyed turns get full tool execution in Harness; anonymous turns stay
text-only until the upstream anonymous posture changes. Effort values
follow the Zen catalog on direct and service variants on the service path;
a catalog effort the service does not advertise fails `INVALID_REQUEST`
naming what it does.

## Testing

`zen-direct.spec.ts` (mock Zen gateway + mock service + mock catalog)
covers headers, keyed/anonymous/down-service routing, discovery filtering,
verbatim efforts, both wire protocols, chat and Responses tool-call round
trips with tool-result serialization, error mapping, cancellation, and
mounted composition; existing service specs pass unchanged.
