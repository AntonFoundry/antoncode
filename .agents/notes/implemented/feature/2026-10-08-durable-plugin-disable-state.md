# Durable plugin disable-state (`plugin-state.json`)

Date: 2026-10-08 · Status: implemented

## Context

The settings UI's plugin inventory (`PluginInventoryGateway.toggle` in `packages/host/plugin-inventory`) updated the Loader entry in memory only — the code comment said it explicitly: avoid `tree.write()` mutations on base bundle files. Any host restart recomposed the tree from the patch layers, so every disabled plugin re-enabled; a rebuild or full reinstall did the same, because the bundle's rows are the source the layers compose over. `configure` had the same runtime-only scope. A user disabling, say, the mail client saw it vanish until the next restart brought it back.

## Decision

Persist the user's toggle/configure intent in `$DSH_HOME/plugin-state.json` — keyed by Loader entry id, `{ version: 1, entries: { [id]: { disabled?, config? } } }` — and apply it at boot as a new patch layer between the home patch (`$DSH_HOME/cordis.patch.yml`) and `--patch` overlays.

- `$DSH_HOME` (`~/.anton/dsh` for the app) is outside every bundle and profile: the state survives restarts, rebuilds, and full reinstalls, and a newly installed bundle row the user disabled before stays disabled — the overlay outranks all bundle layers.
- Writes are write-through from `toggle`/`configure` (immediate `entry.update` first, then the file), atomic via temporary-file rename, and tolerate a missing or corrupt file as empty (the overlay is a convenience, never a boot precondition).
- A re-enable stores `disabled: false` explicitly — user intent, not an absence.
- `configure` stores the entry's full post-merge config because the include patcher replaces a row's whole `config` key; when the live config carries non-JSON nodes (`!!js` results, functions), the config is NOT stored (a wholesale replacement at boot would drop them) and the edit stays runtime-scoped with a warning. `disabled` still persists in that case.
- The layer re-reads per live-reload generation (`composeLive`), so a toggle that landed since boot joins the next recomposition.

Alternatives considered:

- *Settings namespace* (`settings.yaml`): rejected — settings are user-global and plugin-owned; the disable set must be readable by profile boot BEFORE any plugin mounts (chicken-and-egg with the settings service), and per-machine machine-local state is not user settings.
- *Write into `cordis.patch.yml`*: rejected — that file is the user's hand-editable layer; programmatic rewrites would clobber comments and hand edits.
- *Loader `tree.write()`*: the existing rejected path — it bakes composed rows into the profile root, duplicating bundle inserts (profile-boot already rewrites the root every boot to undo exactly that).

## Consequences

- Disabling a plugin now sticks across every lifecycle; re-enabling sticks too.
- The inventory's `configure` on a row with non-JSON config stays runtime-scoped (loud), as before — but rows with JSON-safe config gain durability.
- `apps/cli/src/profile-boot.ts` gains the `statePatches` layer (composeProfile, allPatches, composeLive); `packages/boot/app-boot/src/plugin-state.ts` owns the file contract; `packages/host/plugin-inventory` writes through and peers `@deepseek-ai/dsh-app-boot`.

## Verification

- `packages/boot/app-boot/tests/plugin-state.spec.ts` — merge/patch/corruption/lossy unit coverage plus a real `boot()` composition proving the state layer disables and reconfigures bundle rows.
- `packages/host/plugin-inventory/tests/inventory.spec.ts` — toggle/configure write-through asserted against the state file and the generated patch rows.
