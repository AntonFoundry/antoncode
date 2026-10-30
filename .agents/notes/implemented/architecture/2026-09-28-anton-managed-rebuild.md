# Agent Note: launchd-supervised managed rebuilds for the Anton app

Status: implemented

English

## Problem

`pnpm run anton:build:macos` is a 2–4 minute run that quits the running app, swaps `/Applications/Anton.app`, and relaunches it. Agents launched it detached, so nothing survived to observe: the invoking session dies at the quit step, the build's fate was invisible, a hung build ran forever, and no completion signal reached the relaunched app.

## Decision

`anton rebuild start|status|cancel` supervises the canonical build script through launchd. `start` refuses a duplicate live job, cleans stale state, writes a job plist into the user GUI launchd domain, and returns the persisted job immediately. The plist runs `anton-rebuild-supervise --job <id>`: that supervisor spawns the build in its own process group, stamps `running`, enforces a deadline (default 20 minutes, 2–120 accepted), and terminates the whole group TERM→8s grace→KILL for both timeout and cancellation. State lives in `~/Library/Application Support/Anton/rebuild/current.json` under atomic replacement: job id, launchd label, supervisor pid, child process-group id, timestamps, terminal phase, exit code, and notification flag.

Terminal state is persisted before any notification. The supervisor then posts through the bridge's `/bridge/api/notify` endpoint — which is down for exactly the relaunch window — retrying for up to 90 seconds; delivery failure leaves `notificationPending` durable, and `status` retries it. `cancel` signals only through `launchctl kill SIGTERM` on the job label; the supervisor that owns the child group converts that into process-tree termination and records `cancelled` only after the child exits. `status` validates supervisor identity (label registered plus recorded pid) before trusting a nonterminal record, and fails a record whose owner is gone instead of signaling anything.

The bundle swap itself stays inside `scripts/build-anton-macos.ts`; the supervisor never guesses app or build pids. Seams for tests: `ANTON_REBUILD_DIR`, `ANTON_LAUNCHCTL_PATH`, `ANTON_REBUILD_NOTIFY_URL`, and `ANTON_REBUILD_NOTIFY_ATTEMPTS`.

## Alternatives considered

An unowned `nohup`/detached-spawn chain was the status quo and is what this removes. A always-on launchd daemon was rejected: one transient job per rebuild carries the same durability with no resident state to go stale. CLI-process-tree killing on cancel was rejected: the CLI cannot prove pid identity across bridge restarts; the label-owned supervisor can.

## Consequences

One active rebuild per user, enforced by the label plus durable state across bridge restarts. The invoking session still dies when the build quits the app — by design — but the job outlives it and `anton rebuild status` after relaunch reads the authoritative record and delivers the pending notification.

## Verification

`pnpm vitest run apps/cli/tests/anton-rebuild.spec.ts` covers success, nonzero exit, deadline timeout, cancellation-through-SIGTERM (supervisor marks `cancelled` only after child exit), wrong job refusal, notification retry then durable-pending, duplicate live-job refusal without signaling, stale-record cleanup and fresh start, timeout-range and checkout validation, launchd-label-gone failure on status, pending-notification delivery on status, and cancel-through-launchd with no direct child signaling. `npx tsc -p apps/cli/tsconfig.json --noEmit` is clean; parser coverage rides `apps/cli/tests/args.spec.ts`.
