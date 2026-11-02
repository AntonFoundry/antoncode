# Agent Note: Curated provider catalogs and free-first gateway ordering

Status: implemented

## Problem

The NVIDIA route exposed a live model listing containing retired, non-chat, and otherwise unavailable identifiers, so the picker offered models that could not complete a chat request. OpenCode and OpenRouter model groups also had no display rule for putting free-marked entries ahead of paid entries.

## Decision

The NVIDIA settings route uses a strict, static catalog with live discovery and union disabled. The catalog retains the identifiers that returned successful chat-completion responses during the 2026-10-15 probes, plus an explicit intermittent allowlist for GLM 5.3, GLM 5.3 Flash, and Nemotron Nano Omni because NVIDIA capacity can make those known-working endpoints time out. Retired 404/410 ids remain excluded. Route-level explicit model lists now replace the installed catalog unless live union is requested, matching the documented strict-curation behavior.

The host model catalog stably orders entries whose id or display name carries a free marker before paid or unsuffixed entries for `opencode-free` and `openrouter-free` only. Entries retain their original order within each tier, and all other providers retain their existing order.

## Alternatives considered

**Probe every NVIDIA model at every startup.** This would make picker loading dependent on provider latency and transient capacity, and would repeatedly issue requests solely to construct UI metadata. A verified static catalog keeps startup deterministic; re-probing remains an explicit maintenance action.

**Keep NVIDIA live discovery and filter only obvious non-chat ids.** The provider's listing does not reliably encode current chat availability. Filtering names would still expose models that return 404, 410, or capacity failures, so successful request verification is the curation criterion.

**Sort every provider or infer pricing from arbitrary model names.** The requested free-first behavior is gateway-specific, and a broad name heuristic could reorder unrelated providers. The implementation is limited to the two mixed gateways and recognizes explicit free markers while preserving stable order.

## Consequences

The NVIDIA picker excludes retired and non-chat ids but still exposes intermittent models when the provider has capacity. The retained entries use the saved NVIDIA credential and carry verified context/output metadata where the endpoint supplied it. OpenCode and OpenRouter can add paid entries without letting them precede explicitly free entries, while unchanged providers are unaffected.
