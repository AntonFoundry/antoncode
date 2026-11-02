# Agent Note: Map the Codex route to the OpenAI provider logo

Status: implemented

## Problem

The model picker identifies the OpenAI Codex provider with the route id `codex`, while the local provider-logo map only covered the `openai` and `openai-codex` ids. The picker therefore rendered a fallback initial instead of the bundled OpenAI artwork.

## Decision

The shared `ProviderLogo` map treats `codex` as an OpenAI route and resolves it to `/assets/providers/openai.svg`. A client regression test asserts the emitted asset path for the `codex` provider id.

## Alternatives considered

**Rename the provider route id to `openai-codex`.** This would change a runtime/provider identity used by model selection and settings for a presentation-only defect. The existing route id remains stable and receives an explicit logo alias.

**Add a second OpenAI asset.** The web bundle already ships the OpenAI artwork used by the other OpenAI route ids. Reusing it avoids duplicate branding files and keeps asset ownership in one place.

## Consequences

OpenAI Codex now displays the same local OpenAI logo as the other OpenAI routes in the model picker and provider settings. Custom provider ids continue to use their initial fallback, and the NVIDIA and other provider mappings are unchanged.
