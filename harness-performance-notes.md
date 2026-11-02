# Where VS Code's performance discipline applies to deepseek-harness

Companion to `vscode-performance-discipline.md`. This is a read-only analysis: three passes over
this repository (boot path, session data plane, concurrency/lifecycle), mapped against the VS Code
practices. No code was changed. Every claim carries a file reference; all file:line pointers were
verified during the analysis pass. Machine-specific counts (e.g. "261 links") were measured on this
machine at analysis time.

## 0. Scorecard

| VS Code discipline | Status in this repo | Headline evidence |
|---|---|---|
| 1. Measure first, budgets always | **Missing on the boot path** | Loader `envData.startTime` exists with zero consumers; no `performance.now` in any boot module |
| 2. Lazy loading / activation events | **Partial** | Composition is all-or-nothing (~97 eager import+activations in headless); some lazy islands exist |
| 3. Progressive boot / idle scheduling | **Missing** | No `requestIdleCallback` anywhere; boot fs phases are synchronous-serial |
| 4. Viewport-proportional work | **Partial** | Streaming and projection folds are incremental; resume and one per-event snapshot are full-log |
| 5. Disposables + mechanized leak detection | **Lifecycle strong, detection missing** | Effect-based disposal is uniform; no `FinalizationRegistry`, no test-global leak tracker |
| 6. Fix memory in data structures | **Inverted at the read path** | Durable log is append-only and batched (excellent); live session retains the full log in RAM and resume reloads all of it |
| 7. Keep the main thread cheap | **Largely applied** | worker_threads, child_process, node-pty, remote sandbox, async streaming with incremental SSE parse |
| 8. Bounded caches | **Mostly applied** | WeakMaps, rings, LRU prepared-session cache; two gaps found (jobs-local, SDK client queues) |

## 1. Boot path

The boot sequence (`pnpm dsh --profile headless "task"`): `apps/cli/src/bin.ts` →
`loadLayeredEnv` (`packages/boot/app-boot/src/index.ts:177`) → `prepareProfile`/`composeProfile`
(`apps/cli/src/profile-boot.ts:100,155`) → `boot()` (`app-boot/src/index.ts:759`) → Loader/Include
mount → entry tree import+activation → typert pass → settlement → first LLM request.

### 1.1 O(n) boot costs (n = packages / composition rows / modules)

| Cost | Location | Scale |
|---|---|---|
| Synchronous dependency-closure BFS + symlink healing, **every boot** | `packages/boot/app-boot/src/profile.ts:223` (`healProfilesModuleFallback`), called from `apps/cli/src/profile-boot.ts:101` | O(#closure packages): 261 packages × (resolve probe + `existsSync` + `readFileSync` + `JSON.parse` + link `lstat`/`readlink`), all serial and synchronous |
| Per-row dynamic import + tsx transform of each package's reachable `src/` graph | `vendor/loader/src/config/tree.ts:145`, `vendor/loader/src/config/entry.ts:280` | ~97 imports in headless, ~151 in web; each is a node_modules walk + esbuild transform under the tsx hook |
| Per-entry package.json read/parse in the typert pass | `packages/typert/loader/src/index.ts:315-341` | one `require.resolve` + read + parse per composition row |
| Eager network fetches inside the boot window | `packages/llm/llm-models-dev/src/index.ts:409-411` (`refreshRoutes()` unconditional at mount); `packages/llm/llm-pi-ai/src/index.ts:448` | O(#configured routes) HTTP fetches before the first user event |
| Double `structuredClone` of all patches + a config write per boot | `apps/cli/src/profile-boot.ts:103` (`writeFileSync` of root `cordis.yml`), `composeEntries` | small but serial and on the critical path |

### 1.2 Measurement is absent exactly where it matters most

- `vendor/loader/src/index.ts:68-70` seeds `envData = { startTime: Date.now() }` — a grep across
  `packages/` finds **zero consumers**. The one boot-timing datum the system produces is orphaned.
- No `performance.now`/`hrtime` exists in any boot-path module. Timing exists elsewhere (hook-run
  duration in `hooks-codex`/`hooks-claude-code`, zstd yield budgeting in
  `session-persistence-jsonl`, gate durations in `scripts/run-gates.ts`) — just not at boot.
- Headless mounts no logger service, so loader `showLog` output is silent: boot is quiet by
  construction, which also means unobservable.

VS Code rule 1 ("measure first, budgets always") is the discipline this repo lacks most. The
feel of "a little bit slow" cannot currently be attributed with data from inside the process.

### 1.3 Lazy-loading islands exist — the composition shell does not

Already lazy (correct per activation-event thinking):

- Skill catalog: discovery only on first `ctx.skills.list()` — `packages/skill/skill-filesystem/src/index.ts:182-193,719`.
- SQLite session query: `openAt: never` by default — `packages/bundle/base/cordis.patch.yml:148-152`.
- Langflow sidecar: child spawns on `start()` demand — `packages/flowbuilder/langflow-sidecar/src/index.ts:41`.
- System-prompt assembly and tool-catalog work: per turn, not per boot.

Not lazy:

- Every composition row imports and activates before the first user-visible event; the entry tree
  has no deferred bundles and no activation events — `vendor/loader/src/config/group.ts:71` fans
  out concurrently (`Promise.allSettled`), but readiness is injection-driven, not demand-driven.
- The models.dev datasheet fetch and the model-intel scheduler (`packages/subagent/model-intel/src/index.ts:134,221`) mount eagerly.

### 1.4 The built-bin fast path already exists — the dev loop doesn't use it

- Shipped path: `apps/cli` tsdown-bundles `apps/cli/lib/bin.js` (per-mode chunks); the installed
  `~/.local/bin/dsh` execs it under plain Node — no tsx, no per-module transforms; bare plugin
  names resolve to each package's `"main": "lib/index.js"`. Acceptance tests:
  `apps/cli/tests/built-bin.e2e.ts`, `apps/cli/tests/lazy-search-startup.compat.spec.ts`.
- Dev path: `pnpm dsh` runs `node --import tsx/esm apps/cli/src/bin.ts`, transforming the whole
  reachable `src/` graph on the fly against a 229-entry `paths` map. The repo's own Agent Note
  records measured launch deltas (~0.7s to TUI banner under `tsx/esm` vs ~1.1s under full tsx;
  an earlier hook design cost ~440ms of `makeSyncRequest` wait) —
  `.agents/notes/implemented/architecture/2026-07-29-dsh-source-launch-tsx-esm.md`.
- `pnpm run demo:cordis` / `demo:acp` still use **full** `--import tsx` (CJS hook on) —
  `scripts/demo-cordis.mjs`.

## 2. Session data plane

### 2.1 The write path is the best-engineered surface in the repo

- `Session.append` (`packages/core/session/src/index.ts:610-674`): validate + push, **no I/O on
  the hot path**. O(new data) per event.
- Write-behind batching: `packages/session/session-persistence/src/write-behind.ts:45-47` clones
  each event into a pending buffer and flushes on a fixed 200ms window
  (`DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200`, `coordinator.ts:30`); failed writes re-queue.
- JSONL backend: append + fsync with rollback-truncate, zstd frames per batch by default
  (`DEFAULT_COMPRESSION = 'zstd'`), and packed chunk rows (~60% smaller logs) —
  `packages/session/session-persistence-jsonl/src/index.ts:38,651-679`,
  `format.ts:221-224`. SQLite backend: single transaction per batch,
  `SCHEMA_VERSION = 15` (`packages/session/session-persistence-sqlite/src/schema.ts:20`).
- Durability checkpoints pin flush barriers before first stream chunk and tool bodies
  (`packages/session/session-checkpoint-policy/src/index.ts:34-82`).

This is genuinely VS Code-grade: append-only, batched, never re-reads prior bytes.

### 2.2 The read path inverts the piece-tree lesson

VS Code's lesson was "memory should track the working set, not the file." Here:

- **Resume is O(full log), once**: `prepareCore` (`coordinator.ts:892-931`) → `backend.loadStored` →
  JSONL `readStableFile` reads the **entire file** into a Buffer and decodes **all** zstd frames
  (`session-persistence-jsonl/src/index.ts:292-304`; explicitly no seek: "JSONL is sequential
  media", lines 196-200). SQLite has `loadStoredFrom` (suffix SELECT, `index.ts:225-238`) but
  resume still uses `loadStored` (all rows) because the live session needs the whole log.
- **The full log then stays in memory forever**: `Session.log` (`core/session/src/index.ts:427`)
  — every event, including every `assistant/chunk` delta and every compaction replacement copy,
  for the session's life. Compaction shadows the model surface; it never shrinks the log, memory,
  or the file (`core/session/src/surface.ts:44-47`).
- `Session.fromRestore` re-validates every seed event (envelope check, surface validation,
  deep-freeze; `core/session/src/index.ts:496-539`).

For a multi-hour session with large tool outputs, resume cost and resident memory both scale with
total history, not with the working set.

### 2.3 Two O(n) costs that recur during a run

- **Per append (when measured)**: `eventsSnapshot` is invalidated on every append
  (`core/session/src/index.ts:663`); the next `.events` read does `Object.freeze([...this.log])`
  (line 561) — an O(log-length) shallow copy. TokenMeter's per-event fold reads
  `session.events[state.consumedEvents]` (`packages/llm/token-meter/src/index.ts:160-186`), so a
  measured session pays a full-log array copy per appended event. This is precisely the cost class
  the piece-tree postmortem warned about ("GC can easily eat your CPU time").
- **Per LLM request**: `assertNoActiveCompaction` runs **before** the threshold check on every
  `agent/request-prepared` (`compaction/compaction-basic/src/index.ts:308` vs `:318`), and its
  backward scan (`inspectCompactionEntryState`, `region.ts:517-550`) only stops early when it
  finds both a compaction marker and the last `session/end-seed` — which sits at the resume
  boundary, i.e. near the log's start. Net: a near-whole-log scan per request, plus an
  O(surface) clone in `meter.measure()` and an O(surface) derive rebuild after any compaction
  replace.

### 2.4 Projection is genuinely incremental (the good news)

Header/context folds, derived-message nodes, SurfaceManager deltas, the projection registry, and
TokenMeter's fold all process **new events only** ("each surface node is projected exactly once,
when first seen" — `core/session/src/index.ts:736-765`). Request assembly uses the in-memory
incremental cache with frozen shared references — `agent.ts:491,505` — not a log replay. The
projection-cache cold-read ladder (`session-projection-cache/src/index.ts:166-179`) already
avoids full-log loads for query consumers; the agent-resume path simply does not use it.

### 2.5 Growth inventory

| Holder | Growth | Bounded? |
|---|---|---|
| `Session.log` | O(total events), incl. all chunk deltas | No — by design (event sourcing); compaction doesn't shrink it |
| `Session.derived` + TokenMeter `ReplayState.surface` | O(surface) | Shrinks only via compaction |
| `jobs-local` `store` (`packages/jobs/jobs-local/src/index.ts:102`) | Settled job records (with retained output) never deleted while the owner agent lives — only on owner/service disposal (`:471,494`) | **No — real accumulation** |
| Telemetry `chunkSeen` (`session-telemetry/src/coordinator.ts:68`) | One key per step | Dies with session |
| Prepared-session cache, guard chains, subprocess sets, workflow recorder | — | Yes (LRU 5 / 8-entry ring / set-evicted / run-bounded) |
| SDK client subscription queues (`packages/sdk/client/src/client.ts`) | Unbounded until consumed (standard async-iterator pattern, dropped on `close`) | Consumer-paced |

### 2.6 Tool outputs: producer-side caps only; no cap at commit

`appendToolResult` (`agent-loop/src/tool-calls.ts:268-289`) commits whatever a tool returned,
verbatim, into log + memory + model surface. Caps exist per producer (bash `maxOutputChars`,
pwsh stream truncation with spill files, jobs `outputLimitBytes`, fs `maxBytes`) and post-hoc via
the tool-result pruner — but the pruner runs only when a compaction pass trips
(`compaction-tool-result-pruner`, base patch `thresholdChars: 8192`). Until then, one huge output
rides everywhere.

## 3. Concurrency, off-loading, and lifecycle

### 3.1 "Keep the main thread cheap" is largely honored

- Workflow scripts run on `worker_threads`, one Worker per run, with grace-timed forced
  termination (`packages/workflow/workflow-worker-thread/src/host.ts:149,191-244`); code-runtime
  likewise (`packages/code-runtime/code-runtime-worker-thread/src/index.ts:378`).
- All shell/subprocess work is `child_process.spawn` with detached process groups, bounded output
  collectors (in-memory tail + spill files), and TERM→grace→KILL teardown ladders
  (`packages/subprocess/subprocess-local/src/spawn.ts:350-361,452`; terminal PTYs via node-pty,
  scrollback through `BoundedTextBuffer` — `packages/terminal/terminal-bash/src/session.ts:40-75`).
- LLM streaming is incremental per-chunk: `TextDecoderStream → EventSourceParserStream`, one
  `JSON.parse` per payload, deltas yielded as they arrive (`packages/llm/llm-deepseek/src/sse.ts:32-38`,
  `translate.ts:122`), with an idle watchdog and clean mid-stream abort (`adapter.ts:230-272`).
  Note: open blocks accumulate their full text until `[DONE]` with **no size cap**
  (`translate.ts:138-162`) — unbounded only in the sense that a single response is the bound.

### 3.2 Listener lifecycle: strong contract, no mechanized leak detection

- The Cordis contract is uniform: every registration is a fiber effect, `register()` returns a
  disposer, fibers own a `DisposableList`, and `_unload` walks and disposes everything in reverse
  with per-disposer error containment (`vendor/cordis/src/events.ts:254-260`,
  `fiber.ts:203,520,675-687`). App shutdown disposes the root fiber
  (`app-boot/src/index.ts:792`).
- `getEffects()` provides a per-fiber inventory of live listeners — the raw material for leak
  audits — and tests already assert on it (e.g.
  `packages/extensions/tool-cordis/tests/cordis-lifecycle.spec.ts:44`), plus behavior-level
  "leaked listener would fail" tests.
- **What does not exist**: any process-wide counter, `FinalizationRegistry`, or test-global
  tracker. The repo's own policy (`docs/testing.md:9`: "Every registry gets an HMR-safety test")
  is per-suite and opt-in-by-convention — the difference between VS Code's
  `ensureNoDisposablesAreLeakedInTestSuite` (fails any suite, everywhere, automatically) and a
  style guideline.

### 3.3 Guards are always mounted and bounded

`timeout-policy` (declared `timeoutMs` → structured `TOOL_TIMEOUT` failure), `repeat-tool-reminder`
(`WeakMap` keyed by agent + `RECENT_CAP = 8` ring for ping-pong detection), and `gate-policy` are
rows in the base patch (`packages/bundle/base/cordis.patch.yml:377-378,434-478`) — ship-always,
config-tuned. State in all three is bounded. No VS Code-style concern here.

## 4. Where the felt slowness most plausibly lives

1. **Dev-loop launch (`pnpm dsh` from source)**: tsx transform of ~97 packages' full source graphs
   + the serial, synchronous 261-package healing BFS + per-row typert reads — all before the
   first model request. The built bin (`apps/cli/lib/bin.js`) already skips all of it.
2. **First token of any run**: models.dev route fetches sit inside the boot window; boot latency
   therefore has a network component.
3. **Resume of a long session**: full-file read + full zstd decode + per-event validation +
   permanent retention (`§2.2`).
4. **Long-running session throughput**: O(log) copy per appended event (measured sessions) and a
   near-O(log) scan per LLM request (`§2.3`) — costs that grow with history even when the
   working set is small.
5. **A single huge tool output**: rides in log + memory + request until a compaction threshold
   trips (`§2.6`).

## 5. Opportunity list (documented only — nothing changed)

Ordered by expected impact on "very, very fast":

1. **Instrument boot** — consume `envData.startTime` (or add `performance.now()` phase marks)
   through loader entry import and activation. Rule 1 precedes everything else; today no internal
   data can confirm which of the above dominates.
2. **Use the built bin for more entry points** — the shipped path already exists; `demo:cordis`,
   `demo:acp`, and dev profiles still pay full tsx (or `tsx/esm`) transformation.
3. **Make profile healing incremental or cached** — `healProfilesModuleFallback` re-verifies the
   entire dependency closure synchronously on every boot; a mtime/manifest-fingerprint fast path
   would remove the single largest serial fs cost.
4. **Suffix resume** — `loadStoredFrom` already exists for SQLite; the JSONL backend documents
   that it cannot seek, and resume validation + surface fold need the full prefix by design, but
   the *chunk-delta* bulk (`assistant/chunk` runs) is packed precisely for cheap scanning —
   a resume path that validates headers/surface events and defers chunk payloads is where the
   piece-tree lesson (memory ∝ working set) would land.
5. **De-essentialize `session.events` reads in hot folds** — a direct indexed accessor
   (`this.log[i]`) instead of the invalidated snapshot would delete the per-append O(n) copy
   for TokenMeter-style consumers.
6. **Reorder the compaction preflight** — `assertNoActiveCompaction` runs before the threshold
   check on every request; gating it behind the (cheap) token threshold removes a per-request
   near-O(n) scan in the common case.
7. **Activation-event the network** — models.dev refreshes are natural first-use work, not boot
   work.
8. **Mechanize leak detection** — a test-global disposable tracker (the repo has the effect
   inventory via `getEffects()` to build one on) would convert the per-suite HMR-safety policy
   into a VS Code-style automatic failure.
9. **Bound `jobs-local` settled records** — a cap or retirement policy per owner.
10. **A central tool-output ceiling** — commit-path cap (or immediate pruner pass) so one huge
    result cannot ride the whole surface until compaction trips.

## 6. What is already at or above VS Code standard

- The **event write path** (batched write-behind, zstd, packed chunk rows, append-only, durability
  barriers) — better-instrumented than most production systems.
- **Incremental projection folds** everywhere on the read side except the two hot spots named
  above; request assembly from frozen shared state, no replay.
- **Process off-loading**: workers for workflow/code execution, subprocesses with bounded
  collectors and spill files, PTY scrollback bounds, remote-sandbox backpressure, incremental SSE
  with idle watchdogs and clean aborts.
- **Effect-based lifecycle** with tree-recursive disposal, per-fiber effect inventories, and an
  HMR-safety test policy per registry.
- **Bounded state** in guards, telemetry, subprocess tracking, and prepared-session caching.

## 7. Sources (analysis passes)

- Boot path: `apps/cli/src/bin.ts`, `apps/cli/src/profile-boot.ts`, `packages/boot/app-boot/src/*`,
  `vendor/loader/src/*`, `vendor/include/src/*`, `packages/typert/loader/src/*`,
  `packages/llm/llm-models-dev`, `packages/llm/llm-pi-ai`, `packages/bundle/headless`,
  `packages/bundle/base/cordis.patch.yml`
- Session data plane: `packages/core/session/src/index.ts`, `core/session/src/surface.ts`,
  `core/agent-loop/src/agent.ts`, `agent-loop/src/tool-calls.ts`, `agent-loop/src/runtime-context.ts`,
  `packages/session/session-persistence/src/{coordinator,write-behind}.ts`,
  `packages/session/session-persistence-jsonl`, `session-persistence-sqlite`,
  `session-checkpoint-policy`, `session-projection-cache`, `session-telemetry`, `session-title`,
  `packages/compaction/compaction-basic`, `compaction-tool-result-pruner`, `packages/llm/token-meter`
- Concurrency/lifecycle: `vendor/cordis/src/{events,fiber,registry,utils}.ts`,
  `packages/workflow/workflow-worker-thread`, `packages/subprocess/subprocess-local`,
  `packages/shell/bash-local`, `packages/terminal/terminal-bash`, `packages/e2b/*`,
  `packages/llm/llm-deepseek/src/{adapter,sse,translate}.ts`, `packages/guard/*`,
  `packages/jobs/jobs-local`, `packages/sdk/{server,client,protocol}`, `packages/acp/acp`,
  `docs/testing.md`
