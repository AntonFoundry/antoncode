# Agent Note: Claude Code subscription provider (`claude-code`)

Status: implemented

## Problem

The harness served Claude models only behind an API key (`anthropic`
pi-ai route), leaving Pro/Max subscriptions unspendable: subscription
tokens are refused over direct API calls, and the only consumer was the
external `claude` CLI. The reference (`pi-claude-bridge`, MIT) shells
inference out to Claude Code rather than authenticating, so it offered no
auth mechanics to lift.

## Decision

New `llm-claude` package, route `claude-code`, mirroring the opencode
provider's shape with subscription OAuth instead of Zen:

- OAuth facts (authorize/token endpoints, client id, scopes, S256 PKCE,
  beta header, token shapes) were extracted from the installed Claude Code
  binary's strings plus its observed traffic, then implemented clean-room in
  `claude-oauth.ts` (manual code paste-back, like `claude login` — no
  localhost server). No minified code was copied.
- Zero wire code: the adapter delegates to a `PiAiAdapter` over a synthetic
  `claude-code` profile built from the installed Anthropic catalog via two
  new additive llm-pi-ai exports (`buildProvider`, `catalogProvider` plus
  `catalogModels`). Catalog models are re-stamped to the route key because
  pi-ai resolves the serving provider from `model.provider` (`Unknown
  provider` otherwise — caught by test, fixed in the factory).
- Per-request session resolution (valid token, silent refresh with
  write-back, loud `MISSING_CREDENTIAL` with the login fix); `AUTH`
  failures gain the same guidance whether thrown or delivered as
  error-finish chunks. Live mount in base (the unauthenticated failure is
  the onboarding); keyed `anthropic` stays untouched for API billing.
- CLI `dsh claude-login` (browser open, paste-back prompt, app-home mismatch
  hint shared with the OpenCode command).

## Alternatives considered

- **New Messages wire adapter** — duplicates pi-ai's tested serialize/
  translate/SSE/replay stack for no behavioral difference; rejected.
- **Subscription token through the existing `anthropic` profile** — that
  profile's credential is a raw key with no refresh or login flow, and its
  route id must keep serving API billing; rejected.
- **Shelling out to the `claude` CLI** (pi-claude-bridge shape) — executes
  tools under the CLI's permissions and inherits its agent loop, violating
  Harness-owns-the-turn; rejected.
- **Dormant mount (codex pattern)** — hides the route until configured,
  defeating failure-guided onboarding; mounted live like opencode instead.

## Consequences

Subscription turns get full Harness tool execution with pi-ai's exact
Anthropic behavior. The route needs a stored session for every turn (no
anonymous tier) and the login is CLI-only until the Models-page button
covers Claude. Marshal-adjacent risk: none (no wire code). `claude-code`
shares the Claude logo asset.

## Follow-up: subscription IdP correction

Live login minted console-IdP tokens (good for roles/profile reads,
rejected on inference with a scope error). Diffing our approval URL
against the client's construction showed two gaps: the subscription
login approves at the account IdP (`claude.com/cai/oauth/authorize`,
not the API console) and always sends `code=true`. Both fixed in
`createAuthorizeFlow` (override still available); UI and RPC inherit
the default with no changes.

## Follow-up: catalog freshness, ordering, and a reverted upgrade

The 0.84.2 catalog predates the 5.5 family, so the route cannot offer it.
An upgrade attempt is recorded here because the failure mode matters: 1.3.0
is supply-chain age-blocked, and 0.99.2 (which ships 5.5) carries a
behavioral migration across the shared pi-ai adapter (34 suite failures:
catalog-data drift plus changed stream/error/replay behavior fleet-wide).
A lockfile deadlock (stale rejected entry blocks re-resolution) was cleared
by surgical entry replacement, then everything reverted to 0.84.2 with
suites green. The 5.5 models therefore wait on a dedicated pi-ai 1.x
migration PR once 1.3.x ages past policy — not on more catalog edits here.
`claude-code` shares whatever the installed catalog ships.

The picker orders every provider newest-generation-first (stable,
version-aware, pinned snapshots trailing their floating base) with the
existing free-tier partition intact on the mixed gateways — verified by a
catalog-ordering test through the real `sessions.models` path.

## Testing

`claude-oauth.spec.ts` (10: URL shape, PKCE, exchange, refresh rotation,
state parsing, interactive login, secrecy of notifications),
`claude-route.spec.ts` (7: config bounds, mounted discovery, Bearer+beta+
`x-app` identity on the wire through real pi-ai delegation, 401→AUTH with
hint, expired→refresh with file write-back, unauthenticated refusal),
`invariant.spec.ts` (registration contract); llm-pi-ai, CLI args, logo, and
bundle-base suites pass unchanged. Live turn pending the operator's
`dsh claude-login` (no credential exists on this machine to verify
against).
