# Agent Note: The OpenGateway route's key card on the Models page

Status: implemented

## Problem

`@deepseek-ai/dsh-llm-opengateway` registers the `opengateway` route with `settingsPath: []` in the `llm-opengateway` namespace, and `llm-vazhi` does the same. The Models page decided a card's layout from the owning namespace name, and only `llm-deepseek`, `llm-pi-ai`, `llm-openai`, `llm-models-dev`, `llm-codex`, and `llm-antigravity` had one; every other namespace fell to the hint-only card, which renders "other fields live in settings.yaml" with no key field and a permanently disabled Apply. A route the operator installed could therefore not be given its key from the UI that gives every other route its key — the only paths were editing `$DSH_HOME/.credentials.yaml` by hand or exporting the variable before launch, which a Finder-launched Anton never sees.

## Decision

**The OpenGateway route reads as the OpenAI family.** `layoutOf` maps `llm-openai` and `llm-opengateway` to the same `openai` layout, because the two sections describe the same card: one flat section, one resource-symmetric credential, one endpoint, and a catalog the adapter discovers rather than the profile listing. The card's model-list and protocol fields stay off both, for the same reasons on each.

**Entering a key writes only the credential.** The OpenAI arm records `apiKeyEnv` into the profile when neither the stored profile nor the effective section names one, which is what makes a page-stored key reach `llm-openai`'s derived default. The OpenGateway schema defaults `apiKeyEnv` to `OPENGATEWAY_API_KEY`, so the resolved section already names the reference the card stores under: `refFor` finds it, the `apiKeyEnv` write never fires, and a typed key leaves `settings.yaml` untouched while landing under the reference the adapter resolves per request.

The card's endpoint fold edits `baseURL` as a path op at the section root, which is where that field lives, so pointing a route at a relay is the same operation as on the OpenAI family.

## Alternatives considered

- **A dedicated `opengateway` layout.** Rejected: its body would be the OpenAI arm's key field and endpoint fold verbatim, and a second copy of that JSX plus its `apiKeyEnv`/materialization conditions is exactly what the cross-file clone gate exists to prevent.
- **Have the card also write `apiKeyEnv` for parity with the OpenAI family.** Rejected: the section default already names the reference, so the write would copy a schema default into the user layer, where it would then survive a change to the adapter's default.
- **Give `llm-vazhi` a card in the same change.** Rejected as premature: the Vazhi route authenticates five different upstreams through five references, so a single key field cannot express it and the page would need a per-upstream shape the route has no consumer for yet.

## Consequences

- An `opengateway` key can be added, rotated, and removed from Models like any other route; the row's credential dot reflects the stored reference instead of staying red until a hand edit.
- The mapping is what future adapters follow: a route whose `Config` defaults `apiKeyEnv` to its derived `<ROUTE>_API_KEY`, exposes `baseURL` at its section root, and discovers its catalog reuses the OpenAI card by adding its namespace to that arm.
- `llm-vazhi` still renders the hint-only card, so its keyed upstreams must be configured through `.credentials.yaml` until it gains a per-upstream editor.
- A deployment that stores an OpenGateway key under a custom reference keeps working: the card resolves that reference and stores rotations under it rather than resetting the profile to the default.
