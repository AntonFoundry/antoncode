---
kind: upgrade-guide
description: "Base-backed profiles reserve pi-ai Anthropic and OpenAI Codex routes in favor of native Claude Code and Codex routes."
---

# Native provider ownership in base-backed profiles

## Change

The base bundle changes `llm-pi-ai.config.reservedProviders` from `[openai]` to `[openai, anthropic, openai-codex]`. The configurable-provider directory omits pi-ai `anthropic` and `openai-codex`; native `claude-code` and `codex` remain available alongside native `openai`. Other pi-ai providers remain available. Native Codex uses the console's `codex login` session.

A pi-ai profile configured under a reserved id prevents the entire pi-ai entry from activating, including unrelated configured routes, with `provider route "<id>" is reserved by a native adapter`. The change does not delete profiles or credentials, migrate saved model selections, or convert Anthropic API keys into Claude subscriptions. Standalone pi-ai compositions are unaffected. Later layers that already replace the `llm-pi-ai` config, including saved profile overrides with `[openai]`, retain their explicit reservation list.

## Migration

1. Inspect the `llm-pi-ai` row in your profile's `cordis.patch.yml`, home patch, and invocation overlays. Preserve its complete `providers` dictionary and other settings before editing: patches replace the entire row config, not individual fields.
2. Choose native routes or explicitly retain the legacy pi-ai routes. For native ownership, set `reservedProviders: [openai, anthropic, openai-codex]` in an existing override (or inherit the base default) and remove only `providers.anthropic` and `providers.openai-codex` from that override. Keep unrelated providers and credential records. Configure native `llm-claude` or `llm-codex` independently using their settings; their schemas are not renamed pi-ai profiles. Update saved selections from `anthropic` to `claude-code` or from `openai-codex` to `codex` only when you intend to change authentication routes.
3. To keep keyed Anthropic, remove `anthropic` from the reservation list; to keep pi-ai Codex, remove `openai-codex`. To retain both, set `reservedProviders: [openai]` inside your existing complete override. If you have no existing override, this patch opts out without supplying provider profiles:

   ```yaml
   - id: llm-pi-ai
     config:
       reservedProviders: [openai]
   ```

   Do not replace an existing providers-bearing override with this reservation-only example. Native `claude-code` and `codex` may remain mounted because their route ids differ.
4. Verify the Models directory after the next activation. With native defaults, `claude-code` and `codex` appear without `anthropic` or `openai-codex`; unrelated pi-ai entries remain. With an explicit opt-out, the retained pi-ai entries appear and configured routes activate without a reservation diagnostic. Do not remove credentials as part of this composition migration.
