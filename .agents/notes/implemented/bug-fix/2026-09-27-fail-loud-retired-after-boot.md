# Agent Note: Fail-loud retired after boot: late unhandled rejections degrade, not kill

Status: implemented

## Problem

A background request naming `zai/glm-5.3-flash` before the zai route's live model discovery populated rejected with `UNKNOWN_MODEL` — and `installFailLoud` (installed for the whole process lifetime) turned that unhandled rejection into `exit(1)`. The web harness died, the app watchdog escalated the entire application into the recovery profile, and the automatic repair turn then died on the identical rejection. One recoverable model resolution miss took the whole app down.

## Decision

`profile-boot.ts` captures `installFailLoud`'s uninstaller and retires it the moment the context settles (boot succeeded). A logging `unhandledRejection` handler stays installed instead — required, because with no handler Node's default converts the next rejection into an uncaught exception anyway. The load window keeps its fatal semantics (a plugin entry that fails to mount still exits loudly with terminal release); the serving lifetime treats a late rejection as a degraded surface and keeps serving.

`uncaughtException` is intentionally left at Node's default: a genuine synchronous crash should die and let the supervisor restart.

## Consequences

The app's zai profile additionally pins `models: [{id: glm-5.3-flash}]` (settings-level), so the triggering request resolves even before discovery answers; configured models are always served by `resolveRouteModels`.

## Alternatives considered

**Keep boot-time fail-loud handling for the serving lifetime.** Rejected: a recoverable background model-resolution failure killed the entire app and its repair session.

**Remove the unhandled-rejection handler without replacement.** Rejected: Node would convert a later rejection into an uncaught exception. Serving retains a logging handler; synchronous uncaught exceptions still terminate.
