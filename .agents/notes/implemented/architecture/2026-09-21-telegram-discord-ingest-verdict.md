# Agent Note: Telegram/Discord inbound — cache-scrape verdict and bot-collector path

Status: implemented

English

## Problem

The Phase 5d plan assumed "Discord/Telegram collectors are plain scripts
reading local caches" — that offline message data on disk can feed the
ambient journal without credentials. The backlog item asked for those
collectors.

## Decision

**The cache premise does not hold; do not build cache scrapers.** A
machine probe plus upstream documentation settled each source:

- **Discord**: the desktop client persists no message bodies on disk —
  it hydrates via the Gateway websocket and keeps history in memory; the
  HTTP cache holds media only. On this machine `Cache/Cache_Data` is empty
  and no IndexedDB exists. Verdict: not feasible offline. Token-based
  exporters (DiscordChatExporter) violate the no-credentials constraint and
  risk account bans per the tool's own docs.
- **Telegram Desktop**: not installed here; its `tdata` holds auth, not
  chat history — parser tooling is a credential-extraction path.
- **Telegram for macOS (native)**: present; the postbox `db_sqlite` message
  store is SQLCipher-encrypted with the wrapping key in the macOS Keychain.
  Decryption is a credentials-adjacent, version-fragile path — blocked
  without explicit user opt-in.

**The sanctioned path if a chat source is wanted**: a Telegram Bot API
collector for 1-2 user-owned groups — a bot token the user deliberately
creates, gated behind a `telegramIngestEnabled` settings toggle (default
off), appending the existing journal convention (`## HH:MM:SS` blocks with
`source: telegram`, chat, sender, 500-char excerpt cap, per-chat
high-water `msg_id` dedupe). Effort: 1-1.5 days on the existing
`journal.ts`/`blueant-settings.ts` scaffolding. Privacy guardrails: chat
ID allowlist (not blocklist), excerpt caps, no Keychain/tdata/token-cache
paths ever.

## Testing

Read-only machine probe (paths listed in the research transcript: Telegram
group container, postbox DB header inspection showing SQLCipher garbage
fields, Discord cache/leveldb emptiness) plus upstream docs (DCE token
docs, Telegram forensics write-ups); external claims carry URLs in the
research transcript. No code changed — the journal collector convention
was read from `apps/anton-bridge/src/journal.ts`.

## Alternatives considered

Keychain-unlock postbox decryption (3-5 days, high fragility, TCC
prompts — rejected as default; documented as the opt-in escape hatch).
Discord self-bot/token routes (rejected: ban risk, credential storage).
Waiting for either vendor to expose a local export API (no evidence of
movement).

## Consequences

The Telegram/Discord backlog item closes as a decision record with a
costed, sanctioned implementation path. The journal machine keeps mail +
desktop capture as its message-shaped sources; a chat source arrives only
as the user-tokened bot collector when the user asks for it.
