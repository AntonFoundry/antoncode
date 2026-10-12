# Agent Note: OpenAI-wire reasoning effort correctness

Status: implemented

## Problem

The OpenAI-completions wire route (the `llm-openai` plugin and every adapter
built on it, notably `llm-models-dev`'s `opencode-free` and `openrouter-free`
free tiers) got effort levels wrong in three ways:

1. `reasoningEffortWire` accepted no `medium` level — selecting it threw
   `UNSUPPORTED_REASONING_EFFORT` even though the wire spellings are
   `minimal`/`low`/`medium`/`high` and the JSDoc promised the mapping.
2. `resolveModel` declared `off`/`low`/`high` with a hardcoded
   `defaultEffort: high` for **every** model. The core materializes
   `defaultEffort` into requests, so every free-tier request — including
   ones to models the catalog marks non-reasoning — carried
   `reasoning_effort: "high"` (or `reasoning: { effort: "high" }` on the
   Responses route), and a configured `low` default was reported as `high`.
3. `ModelsDevAdapter` inherited that blanket declaration, so reasoning
   models like OpenCode Zen's `muse-spark-1.3-contributor-free` offered a
   truncated level set with a forced default, and non-reasoning models
   offered an effort control that could not do anything.

## Decision

- The wire mapping covers `medium`, and the declared effort set is the full
  `off`/`low`/`medium`/`high` the route serves (`OPENAI_REASONING_EFFORTS`,
  exported for adapters built on the base class).
- A configured default is declared back verbatim via
  `declaredDefaultEffort` (`max` as `high`); **no configured default
  declares none**. The provider's own default then serves unselected
  requests, which keeps non-reasoning models and gateways that reject an
  unexpected `reasoning_effort` requestable.
- `ModelsDevAdapter.resolveModel` derives reasoning from the models.dev
  catalog entry: `reasoning: true` declares the full set with no default;
  anything else strips the inherited declaration entirely.
- The freeness predicate now requires a *declared* zero cost. OpenRouter
  publishes costless entries that are not free chat models (image and music
  generators, uncosted router models) and absence-of-cost no longer reads
  as free; every OpenCode Zen free entry declares explicit zeros, so that
  picker set is unchanged.
- NVIDIA's live surface is always the published LLM reference unioned with
  the account listing; models.dev contributes only capacities for ids both
  sources already admit, so embeddings/speech/image/video entries that
  `/v1/chat/completions` does not serve never reach the pickers.

## Alternatives considered

- **Per-model wire capability probing** — no OpenAI listing endpoint reports
  reasoning capability, so the catalog flag (where one exists) plus a silent
  provider default is the only honest declaration.
- **Keeping `defaultEffort: high`** — preserves the previous one-chip UX but
  forces reasoning on every request; free-tier reasoning burns quota and
  strict gateways 400 on the unexpected field.

## Consequences

Deployments that relied on every OpenAI-route request carrying
`reasoning_effort: high` must now configure `reasoningEffort` explicitly.
The Zen/OpenRouter free pickers expose `medium`, and `off` on a reasoning
model omits the field instead of disabling a forced high.

## Testing

`llm-openai` covers the wire mapping and the declared-default mapping;
`llm-models-dev` covers the freeness predicate, the reasoning flag parse,
and per-model reasoning declaration/stripping through the mounted plugin;
`llm-pi-ai` covers the NVIDIA servable-id filter with models.dev capacity
enrichment.
