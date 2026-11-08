# Anthropic API-key enablement

Private Host-only local bundle exposing the bounded `anthropic_api_key_enable` tool and `/anthropic-api-key-enable inspect|apply` human command. Both use one operation; activation only registers effects and never edits configuration. Enter the real API key later through Settings → Models, never in a command or conversation.

## Usage and scope

Install through the supported plugin manager. Inspect first, then apply only after the user authorizes enabling the independent API-key route. The human command runs through the existing command registry without a model request; its normal command result records only bounded metadata. Do not apply during plugin activation: ConfigEditor owns profile locking and Loader reconciliation.

Apply targets exactly one addressable `llm-pi-ai` entry named `@deepseek-ai/dsh-llm-pi-ai`. It removes only `anthropic` from `reservedProviders`, retaining every other reservation in order. It adds an absent `providers.anthropic` with `displayName: Anthropic (API key)` and `apiKeyEnv: ANTHROPIC_API_KEY`, or normalizes that label on an existing profile already using the exact explicit key reference. Every other provider, unknown field and existing Anthropic option is preserved. Omitted provider maps and reservation arrays use the inherited layer supplied by ConfigEditor. The separate native `claude-code` entry, model choices and credentials are never touched.

A different or missing explicit key reference on an existing profile, alternate authentication fields, authentication headers, another API protocol, opaque expressions, invalid targeted maps/arrays or an ambiguous target refuse the operation. ConfigEditor validates, persists and reconciles the complete next configuration; ordinary reservation changes can reload the pi-ai plugin, so apply at a quiet point between model requests. A failure propagates; the tool does not claim success before reconciliation completes. Repeated application reports no change. This bundle performs no direct file writes and injects no credentials service.

## Verification

Run `node --check index.js` and `node --test tests/*.test.js`. Tests cover complete configuration preservation, inherited targeted values, explicit-key profile preservation, ambiguous-auth refusals, strict action parsing, error propagation and effect disposal/re-registration for both surfaces. These unit fixtures do not establish live installation or profile reconciliation; the operator must verify those separately after installation.

## Artwork

The generic original MIT-licensed route icon is reused from the sibling `provider-route-cleanup` local bundle. English inventory metadata is in `locale/en.json`.

## Known limitations and deferred work

This is an explicit fixed correction, not a general configuration editor or credential manager. It accepts no arbitrary provider, key, endpoint or config input. Inspect refuses the same ambiguous target configuration as apply. It cannot activate an absent pi-ai adapter or repair a failed plugin load. The bundle may be removed through the plugin manager after verification; the persisted provider correction remains.
