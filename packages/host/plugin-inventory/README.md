---
description: "Projection of Host plugins and agent preset compositions with saved enablement controls and scalar Host configuration edits."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-inventory

English

## Summary

Clients can call `pluginInventory/list` to display the Host's current plugins in load order and each agent preset's flattened composition. `pluginInventory/toggle(entryId, enabled)` changes a non-protected Host plugin, while `pluginInventory/togglePreset(presetId, entryId, enabled)` saves a declared preset child through the active profile editor; later Agents use the revised preset. `pluginInventory/configure(entryId, patch)` merges scalar Host configuration. Each response is a point-in-time snapshot with no change subscription.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Call `pluginInventory/list` when a client or settings page needs to show what is currently composed in the host — which plugins are loaded, enabled, and alive, and what each agent preset would give a session. The Remote is the only entry point: the service is Remote-only and deliberately declares no same-process Cordis `Context` merge.

### What a snapshot contains

Each row is one non-group Loader entry: its entry id, the exact module specifier, the effective enablement (including disabled ancestor groups), and the current root Fiber phase. `pending` means the entry waits to load, `loading` that it is being read, `active` that it is running, `failed` that its fiber rejected, and `unloading` that it is being torn down; `null` means no live root Fiber exists at all. Structural group rows are skipped.

Loader and preset rows can carry optional `meta` with a title, description, or metadata diagnostic. The Host returns available translations and literal fallbacks; the Client selects its language. Metadata diagnostics do not change enablement or fiber phase.

### Per-preset compositions

With a roster composed, `agentPresets` carries one group per preset in roster order: its id, whether the deployment ships it or the user owns it (`trust`, which clients use to localize shipped names), published display name, whether a session naming no preset composes it, and flattened plugin rows — entry id (null when the file row declares none), module specifier, effective enablement, the row's own `!!js` disabled expression when it carries one, and a root-fiber phase when the composition is live. A preset some session already composed answers from its newest standing generation — even when its file has since broken, because the mount is what those sessions run; one never composed since boot answers from its composition file with disabled gates evaluated against the Loader context, and reading never mounts a preset. `conditional` enablement marks a gate the Host could not evaluate, and a broken preset nothing composed stays listed with its reason and no rows. Without a roster the field is absent.

### What you can and cannot do with it

The inventory is a point-in-time read. Host switches persist through plugin state; preset switches require a profile editor, a declared child id, and literal enablement. Conditional rows and duplicate child ids cannot be changed through this API. Changes affect new Agent compositions; existing Agents retain the revision they joined.

Failed entries include the current startup diagnostic read from their Cordis fiber. Recovery removes it; inventory reads do not wait for loading entries or retain a separate error cache.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The gateway is a direct projection with no second lifecycle truth: every `list()` call reads `ctx.loader.entries()` and maps each non-group entry to its public row. Cordis's internal `plugin/status` events already maintain `Entry.fiber` and `Fiber.state`, so a cache would only add another lifecycle truth to keep synchronized. The agent-preset roster is an optional peer resolved per call through `ctx.get('agentPresets')`: its `compositionInventory()` owns preset composition reads, and this package maps root-fiber states onto the public phases.

Display metadata comes from the optional `pluginPackages` service using each Loader tree's resolution base, or the gateway context's base for preset rows. Without the service or the applicable base, `meta` is absent. Reading metadata does not load or activate plugins.

### The phase mapping

Fiber states map onto the public phase vocabulary, with `disposed` folding into `null` — an entry whose fiber is gone has no live root to report. The phase therefore never distinguishes why no live root exists: the entry may never have started, or its fiber may already have been disposed.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `PluginInventoryGateway`: the `pluginInventory` Remote service and the Loader projection |
| [`src/types.ts`](src/types.ts) | Public payload types: `PluginInventoryEntry`, `PluginInventorySnapshot`, `PluginFiberPhase` |

Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the inventory contract is not enough: how the Remote reaches clients, then the Loader it projects and the surface that renders it.

- [Remote assembly](../../api/remotes/README.md) — how clients consume `pluginInventory/list` without importing the Host implementation.
- [Cordis plugin loader](../../../vendor/loader/README.md) — the Loader whose entries this package projects.
- [Plugin inventory settings surface](../../client/ui-settings-plugin-inventory/README.md) — the browser-side projection that renders the inventory.

-----

<a id="model-experience"></a>
## Model Experience

None, as the host-side read-only Loader projection registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what a point-in-time inventory cannot tell a client. They are current package constraints, not a task backlog.

- **Point-in-time state only** — the result contains no durable failure history or subscription; a missing root Fiber is reported as `null`, regardless of why no live root exists.
- **Durable toggles and config** — `toggle` and `configure` write through to the harness home's `plugin-state.json` (see [`dsh-app-boot`](../../boot/app-boot/README.md)), which profile boot re-applies as the highest automatic patch layer; a disabled plugin stays disabled across restarts, rebuilds, and full reinstalls, and a config edit whose live values carry non-JSON nodes stays runtime-scoped with a warning.
- **No layer attribution, addition, or removal** — the service does not identify which bundle, profile, or override introduced an entry, cannot add or remove plugins, and edits only Loader entries, never preset composition rows.
- **Presets appear only with a roster** — a deployment without `dsh-agent-preset-registry` serves Loader entries alone; the `agentPresets` field is absent rather than empty.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
