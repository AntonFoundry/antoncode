# Agent Note: User-authorized subagent model routes

Status: implemented

English
## Problem

Registering an LLM adapter makes its routes reachable, but does not authorize an Agent to choose every reachable model for a child. A single enabled preference over the live adapter registry expands silently when another provider or model appears. The product needs an explicit, stable authorization decision without rendering a potentially large model directory into every parent request.

## Decision

The Host-owned `subagent-model-selection` settings section stores an explicit `enabled` switch and `allowedModels`, an array of exact `{ provider, model }` routes. Enabling requires at least one route; disabling may retain the selected routes for later reuse. The Plugins settings card reads the live adapter directory through `session/modelCatalog`, lets the user stage the switch and routes, and saves both fields in one revision-fenced settings mutation. It stores no adapter-owned display names, descriptions, or reasoning-effort metadata. A stored or staged route absent from the current directory remains visible as unavailable and removable; a provider-local catalog failure does not block other providers or erase saved authorization or an unsaved selection. A connection reset discards the draft because namespace revisions are comparable only within one Host process.

The Host settings service records the current route list in `subagent/model-selection-policy` for every Agent Session — fresh, resumed, seeded, or child — before its first model request, and again for every live Agent after a Settings edit, whenever the current authorization differs from the recorded one. The latest event wins, so each Session log alone reconstructs its authorization at every point. Disabling selection appends an empty list to Sessions that had a policy, which revokes it; invalid Settings on activation or after an edit fail closed by revoking every live authorization. Without a current policy, explicit selection remains restricted to the current parent route. Latest-wins reading keeps the event type and Session format version (a same-version decision): released builds that keep the first policy event still parse these logs, and the rollback limitation below is accepted rather than introducing a new event type.

The fixed `list_subagent_models` schema does not enumerate the policy. At call time, it lists every authorized provider and, per provider, every authorized model in authorization order, marking a provider without a registered adapter and a model absent from the advertised catalog instead of omitting them. Exact lookup requires authorization before resolving model metadata and all supported reasoning efforts, including for ids absent from the catalog. Without a recorded policy, discovery resolves only the parent Agent’s current effective route, even if the catalog omits it. The delegation executor independently checks any explicit provider, model, or effort selection against the same authorization before adapter preflight. A call with no selection fields retains configured or inherited routing.

Model selection has no unrestricted static mode. The default-off Host setting authorizes alternative child routes; without it, the parent route and its supported efforts remain selectable. Each delegation tool’s `modelSelection` option controls only its route fields. One delegation instance per scope enables `modelDiscovery` to own discovery; the setting, discovery, and delegation read the same package-local authorization projection. Web and Desktop presets mount discovery by default, enable spawn route fields, and leave fork route fields disabled to preserve inherited-prefix reuse; custom fork compositions may enable them under the same Session authorization. Tool installation does not sample or expand authorization.

## Alternatives considered

**Render the allowed routes in the delegation description.** Rejected because a large or changing list would enlarge every request and invalidate an early prompt prefix. On-demand discovery keeps the fixed schema prefix-stable and logs directory content only when requested.

**Filter only the settings UI or discovery result.** Rejected because a model can guess a route or retain one from an earlier transcript. Authorization is enforced in the executor that starts the child.

**Infer enablement from a non-empty `allowedModels` array.** Rejected because disabling would have to discard a useful selection or preserve a non-empty array whose meaning depends on write history. The explicit switch is authoritative, and the settings scope submits both fields in one Host-validated mutation so no intermediate state is persisted.

**Store per-route reasoning-effort allowlists.** Rejected because the user decision concerns child models, while effort ids and compatibility belong to the exact adapter route. Every adapter-supported effort remains available after the route is authorized.

**Read current settings on every discovery or delegation call without logging them.** Rejected because the Session log would no longer reconstruct the authority behind a discovery result or a rejected delegation. Appending a log-only event when the authorization changes delivers Settings edits to open Sessions while keeping replay deterministic; the event never enters model history or tool schemas, so it leaves the prompt prefix unchanged.

**Resolve a child's authorization from its root Session at call time.** Rejected because a child log would then depend on another Session's log. Recording the same current authorization in each live Session keeps every log self-contained.

**Keep the first recorded policy as a creation-time snapshot.** Rejected because resumed, seeded, forked, and imported Sessions never received a policy and open Sessions never saw Settings edits, so the Settings page did not control the Sessions the user was working in.

## Consequences

- New adapter registrations and newly advertised models do not expand user authorization.
- Adapter removal or catalog lookup failure can make provider discovery unavailable without deleting the saved route decision; an allowed model remains usable when its adapter accepts it even if the advisory catalog omits it.
- The allowlist itself consumes no parent-request tokens. Only a `list_subagent_models` result enters the transcript. The `modelSelection` option adds three route fields; `modelDiscovery` adds a fixed discovery schema. Both options default off; shipped headless and SDK profiles carry neither.
- The policy event is log-only. It is appended on Agent publication, before either SDK begins its run subscription, and later whenever a Settings edit changes a live Session's authorization. Shipped SDK profiles do not enable this Web-owned preference, so the event changes neither SDK's expected notifications or persisted-session output; package restore tests own its durable projection instead of fabricating an SDK composition solely to emit it.
- Builds released before latest-wins reading keep the first recorded policy. After a rollback, a Session whose authorization was later narrowed or revoked replays with its first route list until the user re-checks Settings or starts a new Session; the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.2/subagent-model-selection-live-settings/guide.md) states this.
- Unit coverage pins settings validation, malformed durable values, recording into fresh, resumed, seeded, child, and already-live Sessions, live Settings edits, fail-closed invalid edits, per-Session containment, revocation during route preflight, shared definitions, parent-route defaults, discovery restrictions, executor denial, and the settings UI’s staged writes and revision checks. The assembled Web scenario pins the real settings document and Plugins card flow.

## Related decisions

The route arguments, adapter preflight, discovery tool, and fork restriction remain owned by [model-selected subagent routes](../../../../packages/subagent/tool-subagent/README.md).
