# Agent Note: Codex subscription account header

Status: implemented

## Problem

The Codex adapter loaded a ChatGPT OAuth access token and account id, but sent the account id in an `openai-account-id` header. The Codex Responses backend identifies subscription requests with `ChatGPT-Account-ID`, so the incorrect header could make valid subscription credentials fail authentication.

## Decision

The adapter sends the stored account id as `chatgpt-account-id` alongside the OAuth bearer token. The UI renders `AUTH` failures as `Provider authentication failed`, avoiding an API-key diagnosis for OAuth routes while retaining the raw diagnostic only in the session log.

## Alternatives considered

**Keep `openai-account-id` as a provider-neutral header.** Rejected: the Codex backend expects its subscription-specific `ChatGPT-Account-ID` header, as used by the official Codex client.

## Consequences

Codex subscription requests carry both authentication values the backend associates with the account. The displayed generic authentication message may still need a follow-up diagnostic if the refreshed OAuth session or subscription is rejected for another reason.
