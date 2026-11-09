---
kind: upgrade-guide
description: Subagent model-selection Settings now apply to open Sessions, the settings service requires `agents`, and discovery annotates unavailable routes.
---

# Subagent model-selection Settings apply to open Sessions

## Change

Previously the Host `@deepseek-ai/dsh-tool-subagent/model-selection-settings` service recorded `subagent/model-selection-policy` only in fresh top-level Sessions, children copied their parent's policy, and resumed, seeded, forked, or imported Sessions kept whatever they had recorded. Settings edits reached only new Sessions.

Now every Agent Session records the current Settings authorization: on Agent publication (fresh, resumed, seeded, forked, imported, or child), on service activation, and for every live Agent after a Settings edit. The latest recorded event wins. Disabling selection appends an empty `allowedModels` list to Sessions that had a policy; that revokes it and restricts explicit selection to the current parent route. A Settings edit to invalid values logs a warning and revokes every live authorization. The service now requires `sessionProjections` and `agents` instead of `sessions`. The Settings panel says changes also apply to open sessions.

`list_subagent_models` now lists every authorized provider and model in authorization order. A provider without a registered adapter shows `unavailable: provider not configured`; a model missing from the provider catalog shows `not advertised by the provider catalog`. The `(no LLM providers)` and `(no advertised models for …)` results no longer occur.

The event type and Session format version are unchanged, so older builds still read these logs, but builds released before this change keep the first recorded policy and ignore later Settings edits and revocations. After a rollback to such a build, a Session whose authorization was later narrowed or revoked replays with its first, possibly broader, route list.

## Migration

1. In custom compositions that mount `@deepseek-ai/dsh-tool-subagent/model-selection-settings`, provide the `agents` service (from `@deepseek-ai/dsh-agent`); the settings service stays inactive, and records no policies, until `agents` is available.
2. Update tooling that parses `list_subagent_models` output or reads only the first `subagent/model-selection-policy` event: read the latest event and treat an empty `allowedModels` list as revocation.
3. Before rolling back to an older build (for example `Anton.previous.app`), re-check the subagent model-selection Settings in that build or start new Sessions there, because it applies only each Session's first recorded policy.
4. Confirm: open a Session, change the allowed models in Settings, and call `list_subagent_models` in that Session without restarting; the result lists the new routes.
