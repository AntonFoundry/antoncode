# Agent Note: Cached profile module-fallback healing

Status: implemented

English

## Problem

`healProfilesModuleFallback` re-verified the installation's entire resolvable dependency
closure synchronously on every boot: a BFS that probes resolution paths, reads thousands of bytes
of manifests, and parses each one, then a per-link `lstat`/`readlink`/`symlink` check. With the
shipped closure at 353 packages the steady-state pass cost about 30ms of the launch's critical
serial path — the single largest filesystem cost before boot-phase timing existed to show it.
Almost every boot re-proves something that changed only when the installation did.

## Decision

The heal writes `.dsh-fallback.json` beside the links it manages: the anchor path, its
mtime/size, and one entry per link recording the target, the manifest that placed that package in
the closure, and that manifest's mtime/size. The next call reads the record first and validates it
with one `readlink` and one `stat` per package — about 5ms for the same 353-package closure.

Validation is deliberately conservative, because a wrong fast path would leave a plugin
unresolvable rather than merely slow: a missing or moved link, a manifest whose mtime or size
changed, a vanished manifest, a different install anchor, a record written for another
installation, or any structural defect in the file all fall back to the full synchronous sync,
which rewrites the record. The file is a cache with no authority of its own: a torn write from a
concurrent heal (two launchers racing) fails the parse and resyncs.

## Alternatives considered

**Fingerprint a package-manager install marker** (`node_modules/.modules.yaml`,
`.package-lock.json`). Those are pnpm/npm-specific and absent in packaged and hoisted layouts;
the closure's own manifests are the portable, authoritative input.

**Trust the record until a link check fails.** A new transitive dependency can appear while every
existing link stays correct, so links alone cannot prove the closure is current; the manifest
stats are what detect an install.

**Hold the closure in a module-level variable.** Process-lifetime state would miss a heal that
another process performed and would not survive the next launch, which is where the cost is paid.

## Consequences

Steady-state boot drops roughly 25ms of serial filesystem work on the shipped closure (measured
30ms → 5ms on this machine, first heal 130ms → 83ms). A record that has gone stale costs one full
sync — the previous behavior — so correctness never depends on the cache. Out-of-tree profile
`node_modules` installs do not touch the closure and keep the fast path.

## Testing

`packages/boot/app-boot/tests/profile.spec.ts` covers: reuse with a repaired missing link, a
re-resync after the app manifest changes (a newly installed dependency is linked), a torn record,
a record for a foreign anchor, a vanished recorded manifest, and a table of structurally malformed
records — each proven by re-healing a link the fast path would otherwise have trusted.
