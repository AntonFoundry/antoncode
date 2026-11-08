# Agent Note: Separate Claude API-key and Claude Code routes

Status: implemented

## Problem

Claude Code subscription login and Anthropic API-key billing authenticate different accounts and entitlements. Hiding pi-ai's `anthropic` directory entry as a duplicate of native `claude-code` prevents an operator from choosing API credits explicitly, even though the existing adapter already supports Anthropic Messages with a named key. Reusing subscription credentials when the API key is missing would make the selected route's billing ambiguous.

## Decision

The base composition configures `providers.anthropic` in the existing `llm-pi-ai` plugin, with display name `Anthropic (API key)` and explicit `apiKeyEnv: ANTHROPIC_API_KEY`. It reserves only `openai` and `openai-codex`. The provider id remains `anthropic`; native `claude-code`, its subscription login, stored session and settings remain unchanged. The installed pi-ai catalog supplies models, so this addition needs no wrapper package, copied catalog or separate wire adapter.

The keyed profile resolves its named reference through the standard credential service. Settings → Models stores the key behind that reference; composition documents contain the reference, not a secret. A missing reference fails `MISSING_CREDENTIAL` before inference rather than falling through to provider-native ambient discovery or a Claude Code session. Anthropic API-credit charges remain separate from Claude Code subscription usage. The change neither migrates credentials nor changes model selections or activates a running installation.

The [Claude Code subscription decision](../architecture/2026-10-16-claude-code-subscription-provider.md) remains active because it owns native login and auth refresh. This decision partially reverses the reservation policy, not the native provider's authentication or ownership. Existing higher-layer overrides replace the whole pi-ai config; their reservation list and providers stay authoritative until explicitly edited, as described in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.2/claude-api-key-provider/guide.md).

## Alternatives considered

**Add a new Claude API-key package or wire adapter.** Rejected: the current pi-ai adapter already supplies catalog discovery, Anthropic Messages transport, secure credential references and Settings integration. A wrapper would duplicate ownership without an independently evolving responsibility.

**Use `claude-code` for both API keys and subscription login.** Rejected: one route would conceal which credential and billing entitlement a request uses, and changing its credential interpretation would alter existing native selections.

**Leave `anthropic` reserved and use ambient discovery as an escape hatch.** Rejected: the keyed route would remain undiscoverable by default, and a missing named key could not safely imply permission to use another account's ambient credentials.

## Consequences

Operators can select API billing without replacing a working subscription route. The profile adds no prompt text or new model-facing message representation; requests use the existing Anthropic translator and Harness tool executor. An explicit route switch can change provider cache reuse and billing, while credential absence remains a visible refusal. Existing configured Anthropic profiles retain their deliberate endpoint, model and credential choices during migration; no automatic configuration rewrite or credential deletion is required.

Required verification covers the base profile and separate directory identity, API-key entry through the credential owner, missing-key refusal despite ambient subscription credentials, and unchanged native subscription routing. Scripted composition verification uses synthetic credentials and intercepted inference rather than a real API key; it does not establish live Anthropic access or available credits.
