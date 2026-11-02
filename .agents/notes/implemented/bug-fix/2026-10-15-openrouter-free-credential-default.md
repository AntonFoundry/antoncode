# Agent Note: OpenRouter Free uses its free-tier credential by default

Status: implemented

## Problem

The OpenRouter Free route defaulted to `OPENROUTER_API_KEY`, while the credential saved by the Anton Models settings flow is `OPENROUTER_FREE_API_KEY`. The former can remain configured but invalid, causing authentication failures whenever the settings override is absent, stale, or loaded by a different profile.

## Decision

The declared `openrouter-free` route now resolves `OPENROUTER_FREE_API_KEY` by default. The route still permits an explicit `apiKeyEnv` override for deployments that intentionally use another credential reference.

## Alternatives considered

**Keep the generic `OPENROUTER_API_KEY` default and rely on the settings override.** This leaves fresh profiles and composition-only consumers dependent on a separate settings document and can select an invalid stale key.

**Delete or migrate the existing `OPENROUTER_API_KEY` credential.** Credential ownership belongs to the user settings and credentials services; deleting or rewriting it would exceed the provider route's responsibility and could break other integrations.

## Consequences

OpenRouter Free requests use the working saved credential in every profile unless explicitly overridden. A deployment that previously relied on `OPENROUTER_API_KEY` must set `apiKeyEnv` explicitly or store the free-tier reference under the new default.
