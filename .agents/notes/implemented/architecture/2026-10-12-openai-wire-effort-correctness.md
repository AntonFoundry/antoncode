# Agent Note: OpenAI-wire reasoning effort correctness

Status: implemented

## Problem

The OpenAI wire route (the `llm-openai` plugin and adapters built on it) must
not present one universal set of reasoning levels for models with different
capabilities:

1. A universal effort list exposed controls on non-reasoning models and
   levels unsupported by particular reasoning models.
2. A configured default could be materialized into requests for models that
   do not accept reasoning parameters.
3. The wire serializer rejected valid explicit OpenAI values such as
   `minimal`, `none`, and `xhigh`.

## Decision

- Each catalog model may declare exact `reasoningEfforts`; a route with no
  per-model effort metadata exposes no effort control, unless its provider
  documents one vocabulary for every model, which the route then offers as one
  ladder (the OpenGateway bullet below). Route-specific catalogs replace
  the shared catalog for endpoints with different model capabilities.
- Request serialization accepts the explicit OpenAI effort vocabulary;
  model metadata gates UI choices and configured defaults. Unsupported
  explicit choices fail before transport, and defaults unsupported by the
  selected model are omitted.
- A provider that documents one effort vocabulary for every model declares
  the `gateway` reasoning dialect (OpenGateway). That dialect sends its
  documented labels verbatim, keeps `off` as the provider default by sending
  no field, and skips the per-model subset filter so a level such as `max`
  reaches a provider that defines it; see the
  [OpenGateway provider route](../feature/2026-10-27-opengateway-provider-route.md).
- `OPENAI_REASONING_EFFORTS` remains exported for source compatibility, but
  model resolution no longer uses this legacy union.
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

- **Infer capabilities from model-name patterns** — aliases and compatible
  endpoints make model names insufficient evidence; deployments declare
  exact capabilities in their catalog instead.

## Consequences

Deployments that need effort selection for custom OpenAI-compatible models
must declare those models' supported levels, or use the `gateway` dialect when
their provider documents one vocabulary for every model. OpenRouter retains its
own catalog-driven effort dialect.

## Testing

`llm-openai` covers the wire mapping, the gateway dialect's verbatim labels and
`off` omission, and the declared-default mapping;
`llm-models-dev` covers the freeness predicate, the reasoning flag parse,
and per-model reasoning declaration/stripping through the mounted plugin;
`llm-pi-ai` covers the NVIDIA servable-id filter with models.dev capacity
enrichment.
