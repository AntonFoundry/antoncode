---
kind: upgrade-guide
description: "Base-backed profiles expose a separate Claude API-key route; existing full-config overrides must allow and configure anthropic explicitly."
---

# Claude API-key and Claude Code routes stay separate

## Change

Base-backed profiles expose `anthropic`, labelled **Claude (API key)**, through the existing pi-ai plugin. The default profile names `apiKeyEnv: ANTHROPIC_API_KEY` and uses the installed Anthropic catalog without a new package or model-id list. `reservedProviders` is `[openai, openai-codex]` rather than `[openai, anthropic, openai-codex]`.

The native `claude-code` route and its console/subscription login remain unchanged. Anthropic API credits are billed separately from a Claude Code subscription. A missing named API credential fails `MISSING_CREDENTIAL`; the keyed route does not fall back to subscription OAuth. This change does not copy credentials, delete grants, change saved model selections, or activate an installed application automatically.

## Migration

1. Inspect the `llm-pi-ai` row in your profile's `cordis.patch.yml`, home patch and invocation overlays. An override replaces the entire row config, so the new base profile does not merge into an existing override. Preserve every other setting and the complete `providers` dictionary.
2. In an existing reservation list such as `[openai, anthropic, openai-codex]`, remove **only** `anthropic`. If `providers.anthropic` is absent, add these fields alongside the existing providers:

   ```yaml
   anthropic:
     displayName: Claude (API key)
     apiKeyEnv: ANTHROPIC_API_KEY
   ```

   This is a provider entry, not a complete replacement patch. If an `anthropic` profile already exists, retain its endpoint, models, other options and intentional named credential reference. Do not replace it with the example. Do not remove unrelated reservations or provider profiles.
3. Activate the reviewed configuration at an agreed safe point. In Settings → Models, use the API-key entry for **Claude (API key)**; the credential store keeps the value behind the named reference. Do not paste keys into chat, Session messages or config text. No key or subscription credential is read or migrated automatically by this upgrade.
4. Confirm that the Models page offers `anthropic` separately from `claude-code`. Select the intended route explicitly: an API-key request requires its named credential, while the native route continues using its own login. The directory alone does not verify API access or available credits; an intentional model request incurs the selected route's billing. See the [adapter reference](../../../../packages/llm/llm-pi-ai/README.md) for credential resolution.
