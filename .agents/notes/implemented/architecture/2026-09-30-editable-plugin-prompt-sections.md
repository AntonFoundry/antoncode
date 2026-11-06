# Agent Note: Editable plugin prompt sections (c0ntext settings card)

Status: implemented

Cross-link: extends [prompt variables and tool-guidance ownership](2026-07-05-prompt-variables-and-tool-guidance-ownership.md) — ownership of each section is unchanged; this note adds a deployment-tunable value the owning plugin itself reads.

## Problem

The c0ntext plugin contributed three system-prompt sections — `c0ntext:memory` (order 117), `c0ntext:paging` (118), `c0ntext:code-map` (119) — with their full text hardcoded in the plugin's `apply()`. Changing what every session's prompt says about the memory contract required editing plugin source and rebuilding. The product ask: edit these texts from the Settings UI, persist them, and apply them without a restart.

## Decision

The overrides live on the plugin's **existing** config, not a new settings namespace: `Config` gains `memoryContractOverride`, `pagingReminderOverride`, `codeMapGuidanceOverride` (schemastery strings, default `''`), and the `Config` schema remains the single gate on which keys the settings bridge accepts. The built-in texts moved to exported `DEFAULT_*` constants; every section registration now calls the exported pure resolver `sectionText(override, fallback)` — a non-blank trimmed override wins, blank restores the built-in text, so clearing the field is the same gesture as resetting it.

Live-effect mechanism: section `text` was already a function evaluated at every assembly, and `installSettingsSection` already re-reads the client settings namespace `c0ntext-context` into the live host `config` on change (`setSource`/`onChange`). An override saved in the c0ntext card therefore reaches the **next assembled prompt with no restart**; the paging override renders only while the ≥80% pressure flag is active, exactly like the built-in reminder.

Client side (`packages/client/ui-settings-plugins`): the three fields ride the existing `CardForm`/`textField` contract (trim on save, empty draft clears the stored key). `ValueField` gained a `multiline`/`rows` variant rendering a textarea with identical chrome, because prompt prose does not fit one-line inputs. Labels and hints added for both locales.

## Consequences

- Prompt text is deployment data, changeable from Settings → Plugins → c0ntext; upgrades keep working because a blank field always means the shipped default, and the defaults stay pinned by test.
- `sectionText` is exported and unit-tested instead of testing through `apply()`: `apply()` needs a full Cordis ctx, and the resolver is the entire semantic surface; the per-section wiring is a one-liner type-checked against the section API.
- A controller-level test staging a blank draft and asserting `host.unset` was removed after investigation: the form plans and executes the identical `clear()` for staged-blank and reset-gesture edits (verified by tracing `plan()`), but `stubSettingsScope` records `host.unset` reliably only for the reset gesture, which the existing suite already covers at CardForm level. Asserting on the double's recording would have pinned stub internals, not product behavior.

### Testing

Plugin: `tests/prompt-sections.spec.ts` (resolver semantics, verbatim-pinned defaults, schema defaults). Harness: `tests/fields.client.spec.tsx` (multiline renders a textarea and stages edits; single-line default unchanged), `tests/stores.client.spec.ts` (override saves as trimmed text through the controller face), package suite 93/93, `tsc -b tsconfig.client.json` clean, full `pnpm run build` green.

## Alternatives considered

- A generic prompt-text override registry in `dsh-system-prompt` (override any section by name from one settings surface): rejected for now — one consumer exists, and ownership stays cleanest when the owning plugin declares and reads its own override fields; revisit if a second plugin wants the same.
- Persisting overrides in the plugin composition (`cordis.patch.yml`) instead of the settings store: rejected — it needs a profile edit and a restart, defeating the live-edit requirement, and it puts prose in a file the app already manages a UI for.
