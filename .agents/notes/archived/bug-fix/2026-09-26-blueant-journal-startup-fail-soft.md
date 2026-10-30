# Agent Note: Blueant journal startup honors the fail-soft contract

Status: implemented
Archived: 2026-10-30

English

## Problem

`startJournalCollector()` created the screenshots directory before entering its guarded tick loop, and `index.ts` starts the collector at module top level. On the affected installation the Blueant journal directory is a symlink to `/Volumes/miDrive/Anton-Data/blueant/journal`; with that volume unmounted the symlink dangles, the recursive `mkdir` rejects with `ENOENT`, and the rejection escapes the module. The Bun bridge process died about 14 ms after every launch, the Mac app's watchdog counted the bridge deaths, escalated onto the recovery profile, and the amber menu-bar chip marked the resulting relaunch crash loop. The [journal collector note](../feature/2026-09-21-blueant-journal-collector.md) already requires that "the collector must never be able to take the bridge down"; the startup directory creation was the one filesystem operation outside that mandate.

## Decision

`journal.ts` creates the screenshots directory through an `ensureDir()` helper that catches creation failure and returns `false`. `startJournalCollector()` logs `[journal] screenshots dir unavailable …` to bridge.log when creation fails and continues: text entries keep landing through `appendEntry()`'s existing fallback, and screenshot capture degrades to `undefined`. `captureScreenshot()` re-attempts directory creation on each capture attempt, so capture resumes by itself once the volume mounts. A keyless regression test starts the collector against a dangling symlink and asserts startup neither throws nor stays silent.

## Alternatives considered

**Point the symlinks back at local storage.** The user moved journal and attachments onto the external volume deliberately; rewriting that layout relocates data behind the app's back and still leaves the collector crash-prone on the next unmount.

**Fail loud at load.** The repo's misconfiguration rule fails loud when a referent is required for the surface to function. The journal is best-effort ambient capture with an explicit fail-soft mandate, so an unavailable volume costs capture, not the bridge — recovery mode exists for harness composition failures, not for a removable disk.

**Create the directory only lazily inside `captureScreenshot()`.** Startup would stay silent about an unreachable target, and a stalled journal would again be undiagnosable. The startup warning keeps the collector note's observable-trail requirement: bridge.log alone must explain why journaling stopped growing.

## Consequences

An unmounted or slow journal volume degrades the bridge to text-only journaling with one warning line instead of a crash loop, and the watchdog never sees the failure. Screenshot capture self-heals when the volume returns; until then each capture attempt re-tries directory creation. The Mac app bundle embeds the compiled bridge, so the fix reaches the installed app only through `pnpm run anton:build:macos`. Keyless vitest coverage exercises the dangling-symlink startup; the full crash-loop reproduction needs the real unmounted volume.
