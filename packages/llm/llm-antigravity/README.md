---
description: "Use Google Antigravity OAuth accounts for Harness model requests without an API key."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-antigravity

English

## Summary

Use Google Antigravity models with a shared OAuth account rather than an API key. Enable the provider route in your Harness configuration, then select a configured model for conversations and Harness tools. Authentication resolves a usable stored account and refreshes access through Google. Model availability and quota remain controlled by the upstream gateway.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount the plugin in a Harness composition and name `antigravity` in its `providers` dictionary. The plugin layers entry configuration with the `llm-antigravity` settings section. With no configured route it remains dormant; a configured route uses the shared Antigravity accounts file rather than an API-key field. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-antigravity) owns accepted settings.

The account reader defaults to `~/.config/opencode/antigravity-accounts.json`; `accountsPath` selects another file. A missing or unusable account fails with login guidance. OAuth resolution refreshes stored accounts in order until one succeeds, and reports failure when none can authorize the request.

## Understand the implementation

[`src/index.ts`](src/index.ts) registers the configured route and resolves connection settings. [`src/auth.ts`](src/auth.ts) reads the shared account file and owns token refresh and project discovery. [`src/adapter.ts`](src/adapter.ts) sends gateway requests and streams their results; [`src/translate.ts`](src/translate.ts) owns Gemini-style request and response translation. Harness tools execute returned function calls; this provider does not start another agent loop.

## Model Experience

### Antigravity request

#### What the model sees

The selected model receives Harness system text as `systemInstruction`, supported conversation text, and translated function declarations. Tool names and JSON schemas are sanitized for the gateway; historical tool results become `functionResponse` parts. Historical reasoning is omitted, and replayed function calls use the translator’s thought-signature sentinel rather than retained original signatures. The adapter adds no authored system prompt.

#### Token effect

Translated conversation text and function declarations consume input tokens. `maxTokens` becomes `maxOutputTokens`; selected reasoning effort maps to a thinking budget. Reported usage separates cached input and reasoning tokens when the gateway supplies those fields. Omitted block kinds contribute no transmitted content.

#### KV Cache effect

Each request resends translated history and system text. The gateway owns prefix reuse; changing the selected model, tool declarations, system text, or translated history can prevent reuse. Reported cached-content tokens are usage observations, not a guarantee of future hits.

## Known Limitations and Deferred Work

- The route requires a usable OAuth account and upstream entitlement; it cannot authenticate with an API key.
- The model metadata advertises image input, but the current translator drops image and file blocks. Do not rely on this route for visual or file content until attachment translation is implemented.
- Historical reasoning and original thought signatures are not retained in requests; function-call replay uses the translator’s sentinel.
- The configured model catalog is advisory. An upstream model or quota rejection remains authoritative even when the model appears in the picker.

### Dev Note

None.
