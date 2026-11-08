---
kind: upgrade-guide
description: "Base-backed profiles reserve pi-ai OpenAI and OpenAI Codex routes for native adapters while keeping keyed Anthropic separate from Claude Code."
---

# Native OpenAI and Codex ownership in base-backed profiles

## Change

The base bundle changes `llm-pi-ai.config.reservedProviders` from `[openai]` to `[openai, openai-codex]`. The configurable-provider directory omits pi-ai `openai` and `openai-codex`; native `openai`, `claude-code` and `codex` retain their route identities. Native Codex uses the console's `codex login` session. The separate `anthropic` API-key profile is available alongside `claude-code`, not replaced by it; its setup and existing-override migration are in the [Claude API-key guide](../claude-api-key-provider/guide.md).

A pi-ai profile configured under a reserved id prevents the entire pi-ai entry from activating, including unrelated configured routes, with `provider route "<id>" is reserved by a native adapter`. The change does not delete profiles or credentials, migrate saved model selections, or convert API keys into subscription credentials. Standalone pi-ai compositions are unaffected. Later layers that replace the `llm-pi-ai` config retain their explicit reservation list and providers.

## Migration

1. Inspect the `llm-pi-ai` row in your profile's `cordis.patch.yml`, home patch and invocation overlays. Preserve its complete `providers` dictionary and other settings before editing: patches replace the entire row config, not individual fields.
2. For native Codex ownership, set `reservedProviders: [openai, openai-codex]` in an existing override, or inherit the base default, and remove only an intentionally retired `providers.openai-codex` entry. Keep unrelated providers, including `anthropic`, and credential records. Configure native `llm-codex` independently using its settings; it is not a renamed pi-ai profile. Update a saved selection from `openai-codex` to `codex` only when you intend to change authentication routes.
3. To keep pi-ai Codex, remove only `openai-codex` from the reservation list in your existing complete override. Do not replace a providers-bearing override with a reservation-only row. Preserve the keyed Anthropic profile; if an older override still reserves `anthropic`, follow the separate guide before activation. Native `claude-code` and `codex` may remain mounted because their route ids differ from the pi-ai ids.
4. Verify the Models directory after the next activation. The native default omits `openai-codex`, while native routes and the separate keyed `anthropic` route remain available. An explicit pi-ai Codex opt-out offers that route without a reservation diagnostic. No credential deletion is part of this migration.
