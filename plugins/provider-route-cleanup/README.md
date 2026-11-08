# Provider route cleanup

Host-only, dependency-free local bundle exposing the explicit `provider_route_cleanup` tool. Activation only registers the tool; it never edits configuration.

## Usage

Install this directory with the supported bundle manager, discover the tool, then call `{ "action": "inspect" }`. After the user authorizes cleanup, call `{ "action": "apply" }` and inspect again. Installation and invocation belong to the parent operator; this source package does not install itself.

Apply targets exactly the addressable `llm-pi-ai` row named `@deepseek-ai/dsh-llm-pi-ai`. It uses `configEditor.edit` to append missing `anthropic` and `openai-codex` reservations, preserving existing reservations including `openai`. It returns the complete current raw config with only `reservedProviders` replaced, preserving all provider maps and unknown fields. ConfigEditor validates, persists and reconciles the edit through the Loader; this plugin performs no direct file writes.

If either duplicate remains configured under `providers`, apply throws and asks for user confirmation before removal in Settings. It does not delete provider configurations, credentials, session/default model choices, Claude Code subscription routes, native Codex login routes, or other providers. Literal arrays/maps are required for fields being inspected; opaque Loader expressions are refused rather than evaluated. Results expose only reservations, configured duplicate ids and a provider count, never provider configuration or credentials.

## Model experience

The tool has one required enum argument and a bounded structured result. Inspect is read-only. Apply requires explicit user authorization and changes only the two fixed directory reservations. The tool does not add prompt sections or modify conversation/session state.

## Verification

Run `node --check index.js` and `node --test tests/*.test.js` from this directory. Tests cover no writes at activation/inspect, full-config preservation, repeat application, configured-route refusal, opaque-value refusal, bounded output, and effect disposal/re-registration. The unit lifecycle test uses a registry/context double. A separate smoke with the checkout's real Cordis `Context` activated the plugin, disposed its fiber and observed zero registrations, reactivated and observed one registration, then disposed it again and observed zero. Actual Loader HMR, persisted reconciliation, live inventory display and rendered artwork require verification after installation by the parent.

## Artwork

`icon.svg` is original MIT-licensed artwork: several provider paths converge to a checked route. The English inventory title and description are exported through `locale/en.json`.

## Known limitations and deferred work

This one-off cleanup predates the separate Claude API-key provider. Do not apply it to remove an intended keyed `anthropic` route; the configured-route refusal leaves that route unchanged.

This bundle is intentionally restricted to the current cleanup request. It does not provide generic configuration access, credential deletion, provider removal or rollback tooling. Inspect reads the active raw row; apply rechecks the latest config inside ConfigEditor's serialized edit callback.
