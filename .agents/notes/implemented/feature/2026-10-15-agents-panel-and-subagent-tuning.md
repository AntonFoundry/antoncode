# Agent Note: Agents settings panel redesign and operator-tunable subagent depth/effort

Status: implemented

English

## Problem

The "Agent presets" settings section let an operator browse and pick presets only through a card grid, with no quick picker showing a preset's description alongside its name. Two subagent swarm defaults were also fixed at deploy time rather than operator-tunable: `tool-subagent`'s `maxDepth` was static Schemastery config requiring a `cordis.yml` edit and a restart to change, and the existing `subagent-child-model` settings section carried a default child model but no default reasoning effort, even though a delegation call already accepts a per-call `reasoningEffort` argument.

## Decision

### Host: operator-tunable recursion cap and default effort

`@deepseek-ai/dsh-tool-subagent` gained a second settings section, `subagent-depth-limit` (schema `{ maxDepth?: number }`), installed only when the plugin's configured `maxDepth` is a number — never for `'provider-managed'`, where the provider, not this cap, owns the recursion budget and a client-tunable override would claim a guarantee the mount-time capability check never made. The section's composition-layer entry carries the configured `maxDepth`, so a settings-scope client can show the deployment default without a separate query. A `validate` hook re-asserts `assertSubagentMaxDepth` on any stored override. At call time the effective cap resolves as: the section's stored override, else the configured `maxDepth`, else (for `'provider-managed'`) no cap sent at all.

The existing `subagent-child-model` section gained a `defaultEffort` field, resolved through a new `resolveChildEffort` helper mirroring `resolveChildModelRoute`'s precedence: the delegation call's own `reasoningEffort` argument wins, then the section's global default, then the plugin's configured `agentOptions.reasoningEffort`, else the child inherits whatever its route otherwise resolves to. No per-session effort layer was added — unlike the model route, a per-call argument already exists and a per-session effort default was not asked for. This reverses one alternative [the per-delegation reasoning-effort note](2026-09-13-subagent-per-delegation-reasoning-effort.md) rejected at the time ("had no per-session consumer"): the Plugins panel's new effort selector is that consumer, and the per-call argument this note added still outranks the section default.

Both swarm-default namespaces are shared by name across every mounted `tool-subagent` row (one swarm-wide knob, not a per-instance setting), and `SettingsProvider.register` fails loud on a duplicate namespace. A deployment mounting more than one row (e.g. `subagent` and `subagent_fork`, the shipped Creator pattern) hit exactly that: the second row's registration threw, silently losing its own read of both sections without taking its tool down. `installSharedSettingsSection` (local to `tool-subagent`) fixes this: the first instance to `apply()` owns the registration as before; a later instance catches the duplicate-registration throw and falls back to a read-only live view of the same resolved value through `ctx.settings.get()`, so every mounted instance stays synchronized with whichever one owns the write path.

### Client: Plugins panel effort selector

The existing subagent-model card in `@deepseek-ai/dsh-client-ui-settings-plugins` gained a second `SelectField` for `defaultEffort`, listing a client-local duplicate of `tool-subagent`'s `REASONING_EFFORT_LEVELS` (a client package must not import a Host package) plus an inherit option. It shares the card's existing staged-edit form (`CardForm`/`textField`) rather than a new field type, since the effort id is a plain string exactly like the model route.

### Client: Agents panel redesign

The "Agent presets" settings section (`@deepseek-ai/dsh-client-ui-agent-preset`) is relabeled "Agents" (the `nav` locale key, which also titles the in-page heading). The shared `PresetMenu` component — already used by the General-settings row and the new-session chip — now renders each option's name and description stacked in its menu item, instead of the name alone; `AgentPresetSection` adds a "Default agent" row at the top using the same `PresetMenu`, wired to the existing roster and `makeDefault` write, so every preset picker in the deployment now shows what a preset is for, not only its name.

A new `DelegationDepthCard` renders inside the Agents section as a plain presentational sub-component (not its own slot registration) backed by a new `DelegationDepthController`, bound to `tool-subagent`'s `subagent-depth-limit` namespace through `ctx.settingsScope`. It follows the same staged-edit convention as every other settings card (drag stages a draft; Save/Discard commit or drop it) and renders nothing while the namespace is unavailable (no `tool-subagent` plugin, or a `'provider-managed'` cap). The card's own slider range is `[0, max(10, deploymentDefault)]`.

## Alternatives considered

**A separate `subagent-depth-limit` field inside the existing `subagent-child-model` section.** Keeping it a distinct namespace means a deployment with no numeric `maxDepth` (a `'provider-managed'` configuration) can leave the section entirely unregistered rather than registering a section whose one field can never meaningfully apply.

**Rendering the delegation-depth control inside the Plugins panel's subagent-model card instead of the Agents panel.** The depth cap is a request-shaping control over how an agent delegates, not a model choice; placing it beside the preset picker keeps every agent-shaping control — which preset, how deep it may delegate — in one place, while the Plugins panel stays the home for per-plugin configuration cards.

**A free-text numeric field for the depth override, matching `numberField`'s existing convention elsewhere in this deployment.** A slider communicates the bounded, small-integer nature of a recursion cap more directly than a text box, and the deployment default read from the settings-scope composition layer gives the slider an informed range without a second round trip.

## Consequences

An operator can now raise or lower `tool-subagent`'s effective recursion cap, and set a default child reasoning effort, from the Agents and Plugins settings panels without editing `cordis.yml` or restarting. Every preset-selecting surface in this deployment (the General row, the new-session chip, and the Agents section's own default-agent dropdown) now shows a preset's description, not only its name, through the one shared `PresetMenu` component. The depth and model/effort overrides take effect on the next delegation only; a running child's budget and route were already fixed when it started.

## Verification

- `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts`: `resolveChildEffort` precedence, the depth-limit override reaching the provider's start request, the depth section never installing under `'provider-managed'`, the child-model section's `defaultEffort` reaching agent options, and two mounted instances sharing both namespaces without the second's registration throwing or losing live updates.
- `packages/client/ui-settings-plugins/tests/stores.client.spec.ts`: the subagent-model card's `defaultEffort` field stages, saves, and resets independently of the model route.
- `packages/client/ui-agent-preset/tests/components.client.spec.tsx` and `tests/section.client.spec.tsx`: `PresetMenu` renders a stacked name/description; the Agents section's default-agent dropdown picks through `makeDefault` and omits broken presets; the delegation-depth card's availability, slider staging, save/discard, reset, and read-only/failed states.
- `pnpm run test:gui` green across all three touched client packages plus the rest of the client/host GUI surfaces.
