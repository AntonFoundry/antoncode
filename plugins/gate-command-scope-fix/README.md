# Deploy gate scope correction

Host-only local bundle exposing the explicit `gate_command_scope_fix` tool with `inspect` and `apply` actions. Activation registers the tool without changing configuration.

## Usage and scope

Install this directory with the supported bundle manager. Call `{ "action": "inspect" }`, then call `{ "action": "apply" }` only after the user authorizes the correction and the updated gate-policy runtime is deployed.

The tool targets exactly the addressable `gate-policy` entry named `@deepseek-ai/dsh-gate-policy`, and exactly one literal rule named `deploy-gate` with tools `['bash']`. It accepts only the authorized original or corrected pattern array. Apply uses `configEditor.edit` to preserve the complete current raw config, changing only that rule's `commandScope` to `shellCommands` and `commandPatterns` to the two fixed roots in `index.js`. Every other rule field, checklist, confirmation, rule and configuration field remains unchanged. The updated raw config is validated against the active fiber before persistence; an old runtime that strips the new scope is refused. ConfigEditor owns validation, persistence and reconciliation; this bundle writes no profile files.

## Model experience

One required enum argument selects read-only inspection or the authorized fixed correction. Results contain only the selected scope, fixed pattern array, preserved rule count and changed flag. They omit checklists, credentials and unrelated configuration. The tool adds no prompt sections or session state.

## Verification

Run `node --check index.js` and `node --test tests/*.test.js` from this directory. Focused tests cover config preservation, idempotence, unsupported runtime refusal, unexpected/opaque configuration refusal and effect disposal. Parent-owned verification covers installation, live invocation, persisted reconciliation and rendered inventory resources.

## Artwork

The original MIT-licensed terminal-and-gate icon is exported as `./icon`; English inventory metadata is exported through `locale/en.json`.

## Known limitations and deferred work

This is not a general gate-policy configuration tool. It cannot change checklists, disable gates, change confirmation, edit other rules, or accept arbitrary patterns. It requires the updated gate-policy runtime to recognize the `shellCommands` scope.
