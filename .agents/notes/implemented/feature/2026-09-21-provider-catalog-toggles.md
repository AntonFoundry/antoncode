# Agent Note: Per-provider catalog enable/disable toggles

Status: implemented

English

## Problem

A provider whose quota runs out keeps advertising its whole model catalog. The session model picker (`/model` popup and the composer seat) renders every registered provider's group, so a dead provider stays in the list the user scrolls past on every selection, and there is no way to set a provider aside without deleting its configured profile and stored key — which is not what a quota outage calls for.

## Decision

Catalog visibility is a host-owned settings fact, not per-provider config. The gateway (`@deepseek-ai/dsh-host-apiproxy`) owns one settings namespace, `model-catalog` (`{disabledProviders: string[]}`), mounted through `installSettingsSection` in `ApiProxyService` with the canonical optional-settings wiring. `buildModelCatalog` reads the resolved section live per request and drops listed providers from both catalog surfaces — `session.models` and `llm.models` share the one filter, so a disabled provider produces neither a group nor a failure row.

The advisory-catalog rule absorbs the semantics: a disabled provider's `current` selection stays `routable` and keeps serving, because catalog membership was never a routing whitelist. Disabling shortens the picker; it does not strand a session.

The Models settings page renders the switch as the first action on every provider row (`ui-settings-models`). The store derives per-row `enabled` from the same `settings.describe` snapshot it already fetches — the `model-catalog` namespace arrives without a new wire call — and the toggle writes the whole `disabledProviders` array through one `settings.mutate` carrying the described `expectedRevision`, so a concurrent edit elsewhere refuses as `settings-conflict` instead of being clobbered. A disabled provider keeps its row, profile, and credential; its name dims and the switch announces the state change through accessible labels. The pushed `settings/document-updated` event refreshes every open surface, including the model picker, without polling.

The client model-selection package is unchanged by design: `ModelDirectory` renders exactly the host-reported groups and already supports a `current` selection missing from them.

## Testing

`api-proxy-models.spec.ts` covers disabled filtering on both catalog surfaces, the kept `routable` selection on a disabled route, re-enabling without a restart, and the no-settings default (everything enabled). `ui-settings-models` specs cover the namespace join (absent namespace = all enabled), the mutate payload with `expectedRevision`, list composition across quick toggles, the refused-write announcement, and the read-only lockout.

## Alternatives considered

**A `disabled` field in each provider's settings profile.** Six provider packages would grow a UI-catalog flag inside behavior config, every adapter's schema and editor would need the field, and "is this provider in the picker" would have as many owners as there are adapters. One central list keeps the fact where the catalog is built.

**A per-session or client-local hidden list.** The motivation is quota exhaustion, which outlives a session and follows the user across surfaces; storing it in the browser would re-hide providers on every new session and diverge between the web app and other clients. The settings document is the one store both the page and the host already read.

**Filtering in the client picker.** The picker would need the disabled list pushed to it, both selection entries would filter independently, and a host-scoped consumer (`llm.models`) would still show the dead provider. Filtering at `buildModelCatalog` fixes every present and future consumer in one place.

## Consequences

Setting a quota-exhausted provider aside is one switch, reversible without touching credentials or profiles, and the shorter catalog reaches every consumer of the two RPCs. The cost: `disabledProviders` is a whole-array write (path ops cannot splice), so two simultaneous toggles compose only because each reads the snapshot at click time — a genuinely concurrent edit from another device still conflicts on `expectedRevision` and needs a re-read. A disabled provider's models also disappear from discovery surfaces that reuse the catalog, which is intended; nothing about dispatch changes, so a session already on that provider keeps working until the user picks another route.
