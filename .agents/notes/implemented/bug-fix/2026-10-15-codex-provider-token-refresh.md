# Agent Note: Codex provider refreshes server-expired OAuth tokens

Status: implemented

## Problem

The Codex adapter trusted a locally unexpired JWT even after the Codex Responses backend rejected that access token as expired. The request stopped at `AUTH` and never used the still-valid refresh token that OpenCode uses for its OAuth session.

## Decision

Codex Responses requests retry once when the backend returns `401` with `error.code` `token_expired`. The retry forces an OAuth refresh through the shared Codex client id, atomically persists the rotated token pair, and sends the refreshed account and residency metadata. Requests also carry OpenCode's `originator` marker and the canonical `ChatGPT-Account-Id` header.

## Alternatives considered

**Refresh on every request.** Rejected: it rotates refresh tokens unnecessarily and creates avoidable contention with the Codex CLI and editor.

**Trust the JWT `exp` claim alone.** Rejected: the backend can invalidate an access token before that claim, as the observed `token_expired` response demonstrated.

## Consequences

An access-token revocation or server-side expiry recovers transparently when the refresh token remains valid. A provider response that is not explicitly `token_expired` still surfaces as `AUTH`, and a failed refresh remains an authentication error requiring the existing Codex login flow.
