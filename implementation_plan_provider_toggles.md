# Per-provider enable/disable toggles for the model catalog

Goal: an enable/disable switch per provider in the Models settings UI, persisted host-side, so disabled providers' models drop out of the session model selection list (the /model picker). Default = enabled. Toggling is for quota-exhausted providers the user wants out of the picker.

## 1. Settings seam — central `model-catalog` namespace

- Add a settings namespace `model-catalog` owned by apiproxy: `{ disabledProviders: string[] }`, wired via `installSettingsSection` in the `ApiProxyService` constructor (`packages/host/apiproxy/src/index.ts:98`). Precedent: `agent-default-model` (`packages/core/agent-default-model/src/index.ts:72-82`).
- Per-provider `disabled` fields rejected: would touch 6 provider packages and mix UI-catalog state into behavior config.
- apiproxy already reads settings optionally via `ctx.get('settings')` (api-proxy.ts:1935); `'settings'` stays out of `static inject`.

## 2. Host filter — `buildModelCatalog`

- `packages/host/apiproxy/src/api-proxy.ts:293-342`: read `disabledProviders` from the settings namespace; skip those provider ids when mapping `ctx.llm.listProviders()` (line 297) into `ModelProviderGroup`s / `ModelCatalogFailure`s.
- One filter covers both `session.models` (lines 2223–2231) and `llm.models` (lines 3521–3523).
- `current` + `routable = routeServed(current.provider)` (line 2229) stay independent of groups: keep a disabled provider's current selection usable — catalog membership is advisory (`SessionModels` JSDoc, `api/sessions.ts:151-168`).
- No wire-schema changes (`api/sessions.schema.ts:180-203` untouched).

## 3. Settings UI toggle — ui-settings-models

- No shared Switch primitive exists; follow the local `role="switch"` + `aria-checked` + `data-checked` button pattern (`GatePolicyCard.tsx:75`, `PluginInventorySettingsTab.tsx:267`).
- Insert the switch as the first child of `rowActions` (`ModelsSection.tsx:356-390`).
- Store join is free: `load()` already puts every namespace in `state.namespaces`, so `model-catalog` arrives without new fetches; `store.ts` derives per-row `enabled` from it.
- Writes go through `api.settings.mutate` on `model-catalog` with `expectedRevision` (set/unset membership in `disabledProviders`); the existing pushed `settings/document-updated` subscription refreshes the page.
- Add `locales.ts` copy (enable/disable provider, switch aria labels).

## 4. Client picker — zero changes

- Host-side filtering suffices: `optionsOf`/`selectionOf` (`ui-model-selection/src/client/index.ts:48-94`) build from host-reported groups, both entries `load()` on open, and a `current` provider missing from groups is already supported (`routable` flag).

## 5. Tests

- `packages/host/apiproxy/tests/api-proxy-models.spec.ts`: disabled filtering, routable-`current` kept, enabled-by-default, no-settings fallback.
- `ui-settings-models` store/components specs: namespace join + mutate payload on toggle.
- Picker regression case in `ui-model-selection`.
- Checks: `pnpm run test -- <pkg>` for touched packages, `pnpm run typecheck`, `pnpm --filter <pkg> run bundle`, `pnpm run test:gui`.

## Risks

- Settings namespace registration must not fail when `settings` service is absent (optional read, empty catalog filter).
- Toggle + pushed-invalidation reload must not clobber concurrent edits (use `expectedRevision`).