# Agent Note: pi-ai liveModelUnion — curated routes join the live listing

Status: implemented

English

## Problem

The Anton deployment pinned the zai route to `glm-5.3-flash` for boot-time default-model resolution and commented the pin as "union semantics keep catalog + live models". The code delivered the opposite: a non-empty `models` list made the startup live-models.dev refresh skip the route entirely, so the picker served two GLM models while the gateway advertised seven. [llm-pi-ai catalog union + generalized live refresh](2026-09-27-llm-pi-ai-catalog-union-and-nvidia-route.md) unions a route's configured models with its installed catalog and generalizes the refresh, but kept strict curation for pinned routes — the pin still suppressed every discovered id.

## Decision

Provider profiles accept `liveModelUnion: true`. On a route with both an explicit `models` list and a live-refreshing provider entry (`MODELS_DEV_ROUTE_PROVIDERS`), the flag keeps the startup models.dev (or endpoint-listing) fetch running and unions the discovered ids behind the configured entries; the installed catalog serves anything neither source named, deduplicated through one declared-id set in precedence order configured → live → installed. Without the flag the prior contract stands unchanged: a `models` list is strict curation, the refresh gate skips the route, and the served catalog is exactly the list plus the installed catalog.

The resolver (`resolveRouteModels`) itself gains no flag knowledge — it unions whatever sources the caller passes. The opt-in is enforced where the request is assembled (`resolveProfiles` passes no `liveModels` beside a non-empty list without the flag) and where the fetch is gated (`refreshModels` skips curated routes unless the route opted in), so the picker surface and the network behavior flip together.

## Consequences

A route cannot both hide a model the live listing returns and keep the live ones: with the flag set, everything models.dev publishes for the provider reaches the picker. Routes needing a stable public surface omit the flag, so curated deployments (renamed ids, subscription-gated subsets such as the nvidia route) keep their exact surface.

## Verification

`pnpm vitest run packages/llm/llm-pi-ai/tests/{catalog,models-dev,config,dynamic-config,discovery}.spec.ts` — the catalog spec's live-materialization case asserts strict curation keeps the live id out, and the union case asserts configured fields win, discovered fields land, and installed ids deduplicate against both. `npx tsc -p packages/llm/llm-pi-ai/tsconfig.json --noEmit` is clean.

## Alternatives considered

**Treat a configured model list as strict curation on every route.** This remains the default, but cannot serve a deployment that pins boot models while also needing discovery. An explicit opt-in joins live models without changing curated deployments.
