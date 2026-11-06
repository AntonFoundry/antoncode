# Agent Note: Boot phase timing

Status: implemented

English

## Problem

Nothing on the boot path measured itself. The Loader seeds `envData.startTime`, but no module consumed it, and no boot module called `performance.now()` or `hrtime`. Timing existed elsewhere (hook-run durations, persistence yield budgeting, gate durations) — just not where "the launch feels slow" is observed. Headless mounts no logger, so the Loader's own log output is silent, which makes boot quiet and unobservable at the same time. Attributing a slow start therefore required re-instrumenting from scratch each time.

## Decision

`dsh-app-boot` exports a passive `BootTiming` recorder (`mark(phase)`, `phases()`, `totalMs`, `format()`). Marks measure against `performance.now()`, which starts at process start, so the first phase also carries module import and argument parsing. The recorder never prints.

`boot()` accepts an optional sixth `timing` argument and marks the phases it owns: `setup` (context, Loader install, host preparation), `mount` (include tree mounted), `settle` (loader settled), `activate` (activation audit passed). The profile launcher marks `heal`, `profile`, and `compose` before it calls `boot()`, so both halves of a real launch land in one recorder. `DSH_BOOT_TIMING=1` makes `runProfile` print the single summary line to stderr after the tree settles; unset, nothing is emitted.

## Alternatives considered

**Log through the Loader's logger.** Headless mounts no logger service, so the report would vanish on the surface that most needs it, and app-boot would gain an output dependency.

**Provide the timings as a context service.** No in-process consumer exists today; a service without a current owner is the premature abstraction the package rules reject. The CLI owns the diagnostic channel and can hand the recorder to a future consumer when one exists.

**Always-on stderr line.** Boot is quiet by construction; unconditional output would change every surface's startup transcript for a diagnostic most runs do not need.

## Consequences

A slow launch can now be attributed from inside the process with one opt-in line instead of guesswork, and the numbers are stable enough to compare across machines and runs. Recording costs five clock reads per boot. The `envData.startTime` seed remains unconsumed; it measures a different origin (Loader construction) and would duplicate the recorder.

## Testing

`packages/boot/app-boot/tests/boot-timing.spec.ts` pins gap arithmetic, totals, and the summary line with an injected clock; `app-boot.spec.ts` boots a real leaf tree through the Loader with a recorder and asserts the four phases arrive in order.
