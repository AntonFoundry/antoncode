# Agent Note: Free-model reasoning options follow catalog values

Status: implemented

## Problem

The models.dev adapter offers Off, Low, Medium, and High for every model marked as reasoning-capable, even when the catalog names different efforts or only a toggle. OpenRouter models that support Minimal, Extra High, or Max cannot be selected accurately, while a toggle-only model appears to accept levels it never declared.

## Decision

The adapter reads each free model's `reasoning_options` effort values from models.dev and publishes exactly those levels in the Harness picker. OpenRouter values are sent unchanged in `reasoning_effort`; models with no named effort values publish no effort picker. The local OpenCode service adapter takes its own exact variant list from `/api/model` and displays `xhigh` as Extra High.

## Alternatives considered

**One global effort list for all reasoning models.** A boolean reasoning flag does not establish which levels the provider accepts, so a global list advertises unsupported controls.

**Clamp unknown levels to High.** This makes Extra High and Max selections silently spend a smaller reasoning budget than the user selected.

## Consequences

Model selectors show only known effort levels and preserve the provider's exact wire value. Toggle-only and budget-token-only models have no effort picker until the adapter implements those distinct controls. Catalog freshness determines when newly published levels appear.
