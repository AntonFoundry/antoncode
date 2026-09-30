# Agent Note: Anton recovery mode was a bridge-death cascade

Status: implemented

English

## Problem

The Anton menu-bar app escalates to the first-party-only `recovery` profile when the harness stays down longer than a deliberate stop explains, or when three bridge deaths land inside 300 s. Once there it could not leave: the tray stayed amber and "Exit Recovery Mode" appeared to do nothing.

The escape hatch was itself the cause. `swapBridge` — the single path used by both `enterRecovery` and `exitRecovery` — cleared its `terminatingBridge` guard synchronously, but the outgoing process's `terminationHandler` was dispatched to the main queue and therefore ran later. By then the guard was already false and `bridge` already pointed at the replacement, so every deliberate swap was counted as an unexpected death: the live handle was nilled and another bridge was spawned. The duplicate could not bind port 3742 and exited with `EADDRINUSE` (recorded in `bridge.log`), which supplied a second death; `bridgeDeaths` was never reset, so the next exit attempt re-cascaded immediately. A user-visible symptom of "recovery mode will not exit" was in fact a self-sustaining process loop.

Two facts hid this. Nothing recorded a watchdog decision anywhere, so the escalation reason was only inferable from the amber chip. And the reported failure looked like a broken main profile, while the build's boot smoke shows the `web` profile composes and reaches ready — the recovery was spurious.

## Decision

`AntonApp` owns bridge identity rather than a boolean:

- `bridgeExited(_ exited: Process)` ignores any process that is not the current `bridge`. A superseded process's termination can no longer nil the live handle or be counted as a crash.
- `swapBridge` clears the outgoing process's `terminationHandler` before terminating it, and every spawned bridge is retained in `bridges` so `applicationWillTerminate` retires all of them. A bridge left behind by a swap would otherwise keep holding port 3742.
- On launch, `startBridge()` probes `GET /bridge/api/status` before spawning: a bridge serving this bundle's root is adopted instead of duplicated, and a listener serving a different root is reported through an alert with no second bridge started.
- `POST /bridge/api/bridge/shutdown` retires an adopted bridge through the bridge's own `shutdown()` path, so reclaiming the port never needs a signal or a guessed process id.
- `exitRecovery()` sets a pending state instead of clearing `recoveryMode`. The app stays on the recovery profile until a status poll reports the `web` profile running; a 45 s timeout keeps it in recovery and records why rather than bouncing back silently.
- The bridge reports `repair: "done"` only when the repair turn exits 0 **and** `repair-result.md` exists, so a turn that fixes nothing cannot drive the automatic exit.
- Every watchdog decision — launch, unexpected exit with elapsed lifetime, escalation, enter/exit, confirmation or timeout — goes to `Logger(subsystem: "dev.antoncode.anton", category: "watchdog")`.

`BridgeStatus.Harness` decodes the `profile` field the bridge already returned, which is what makes a verified exit possible.

## Alternatives considered

**Delay the guard reset instead of tracking identity.** A timer only narrows the window; the handler's delivery time is not observable, so the same miscount returns under load.

**Never escalate to recovery.** The degraded profile is still the right answer for a genuinely broken composition — the build's boot smoke disables a failing loader entry and the recovery surface is where repair happens. The defect was the trigger, not the escalation.

**Terminate the stale bridge with a signal.** Rejected: project policy forbids guessed PIDs and `kill`/`pkill` for lifecycle. Adoption plus the bridge's own shutdown endpoint reclaims the port without either.

**Let the automatic repair turn fix the profile.** There was nothing to fix: the `web` profile boot-smokes clean, and no `repair-result.md` was ever produced because the recovery bridge itself died on `EADDRINUSE`.

## Consequences

Recovery mode is now entered only on evidence about the *current* bridge, and leaving it proves the web profile is running before the chip turns green. Exiting an unrecoverable profile surfaces a timeout in the log and tooltip instead of an apparent no-op.

An adopted bridge is not a child of the running app, so quitting Anton will not stop it; the app retires it through `/bridge/api/bridge/shutdown` when a profile swap needs the port, and `applicationWillTerminate` covers the ones it spawned.

The observability gap is closed for the watchdog path only. Wake-word and audio decisions still log through `NSLog` and their own `os.Logger` categories.
