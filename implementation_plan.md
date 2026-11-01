# Anton on upstream 0.2.2 — port, not merge

## Decision

**Rebuild Anton on upstream `0.2.2-alpha.2` by porting our additive packages onto an upstream-descended branch.** The staged-merge path is abandoned; `merge/upstream-0.2` and tag `anton-pre-merge` are retained as references.

The branch descends from `upstream-dsh-v0.2.2-alpha.2`, so future `git merge upstream/master` stays near-clean permanently.

## Hard constraints

1. **The UI's look and feel must not change.** Verified against `.anton-visual-baseline/`, not assumed.
2. **Never boot the ported runtime against the live `DSH_HOME`.** See the session-migration gate below.

## Current state (verified)

- Branch `anton/on-0.2.2` = upstream `0.2.2-alpha.2` + visual baseline + **21 ported packages, 13 of them now mounted as bundle rows**. **Build 10/10 gates; `verify-cordis-config` 305 files pass.**
- Upstream's own test baseline on this machine: **24 failed / 50,670 passed**. Compare against this, never zero.
- Safety refs: `anton-pre-merge` = `8444d4c7e5`; `merge/upstream-0.2` = `60080b9bda`.

## Porting is two steps: port AND compose

A ported package without a bundle row is **present but inert** — it compiles, tests, and bundles while contributing nothing at runtime. All 21 ported packages were initially unmounted. Every port now ends by adding its row and re-running `npx tsx scripts/verify-cordis-config.ts`.

Subpath rows (`pkg/direct`, `pkg/tools`) need a **hand-written** `tsconfig.base.json` path alias outside the generated block; the generator emits bare package names only.

## Porting recipe (scripted at `.anton-port/port-package.py`)

Per package: copy from `anton-pre-merge`; delete `src/invariant.ts` **and any invariant `describe` block inside a normal spec**; set version `0.2.2-alpha.2`; DSH deps `workspace:*`, vendor `workspace:~`; drop the `./invariant` export, its `files` line, and `dsh-invariants`; remove the invariants tsconfig reference; collapse the `tsdown.config.ts` invariant entry; register in `tsconfig.host.json` / `tsconfig.client.json`; run `pnpm run gen-tsconfig-paths`; `pnpm install`; fix drift; **then mount the row.**

**Verify with `pnpm run build` (10 gates), never `tsc -b tsconfig.host.json`** — the raw form bypasses the `--max-old-space-size` wrapper, OOMs, and can leave a `.tsbuildinfo` that reports phantom errors. A per-package build compiles only `src`, and vitest does not typecheck, so test-file type errors surface only in the aggregates. Also run `npx oxlint <pkg>` (type-aware); the pre-commit hook runs a weaker config.

### Known API drift

- Invariants deleted; `ToolGuard` is synchronous; settings are **Config-derived** (`installSettingsSection` gone; namespace from `ctx.fiber.entry?.options.id`).
- `session.events` → `snapshotEvents()`; the `'plugin'` message source is gone (each plugin declares its own kind); tool results are their own `role:'tool'` message; `CallId` → `ToolCallId`; `tools.execute` takes a **batch** and needs an executor plugin; `agent/pre-step` carries `modelSelection`; the session header is readonly.
- `JsonValue` → `dsh-util-values`; `dsh-code-runtime` → `dsh-ptc-runtime` (`Code*` → `Ptc*`) with a `resolve`/`run` split; shell settles through `execute()` + `result()`; `SubprocessHandle.pid` is gone; `crypto.randomUUID` restricted (use `dsh-util-crypto`); `WebFetchResult.status` → `statusCode`, text body `.text` → `.content`.
- Reading an optional service through `ctx.get` **untyped hides real drift behind `any`** — add the type-only import.

### Client-face drift

- Client packages use **split compiler faces**: solution-only `tsconfig.json` + `tsconfig.host.json` / `tsconfig.client.json` leaves; dependents and the aggregates reference the **leaf**.
- `clientBundle(import.meta.dirname, …)`, not the package name.
- `ClientContext` was our re-export — use cordis `Context`. `defineStore`/`EngineStoreHandle` → `dsh-client-store`; `ctx.slots` → `dsh-client-ui-renderer`; `SessionListState` → `dsh-client-ui-session`; `ChatSnapshot` → `dsh-client-ui-chat`; `SessionId`/`transportError`/`RpcId` → `dsh-client-connection`; `WorkspaceView` → `dsh-api-workspace-controller`; `SessionSummary`/`ISessions`/`SESSION_SEARCH_RESULT_LIMIT` → `dsh-api-session-controller`; `SearchBlock` → `dsh-client-ui-primitives`; `searchCardModel` → `dsh-client-ui-tool`.
- Client settings: host declares its own `Config` + `ctx.settings.configure({ auto })`; the browser half reads `ctx.configForms.get<T>(namespace)`.

## Verified capability losses (triage; word-matched with `grep -rlw`)

Severity does **not** track deleted line count — it mispredicted in 5 of 5 cases.

| area | status | detail |
|---|---|---|
| `subagent/subagent` + `tool-subagent` | **CRITICAL** | No continuable concept: `startContinuable`, `registerContinuableSetup`, `reportFrom`, `drainContinuableDescendants`, `backgroundMode` all **0 files**. Loses durable child ids, `send_message` continuation, the report seam, completion notices, `list_agents` ready/idle. The port's Config accepts `provider`, `toolName`, `modelSelection`, `modelDiscovery`, `agentOptions`, `maxDepth` — **six** fields, not four. |
| `core/tools` | **BEHAVIOURAL** | `presentAs`, `ToolPresentationMode`, `renderToolsCatalog`, `TOOL_SEARCH_NAME` all **0 files** → paged tool presentation gone (token/KV-cache regression with a large roster). `tools:working-discipline` section gone while its `efficiencyDiscipline` setting survives, so the toggle would instruct nothing. |
| `client/ui-conversation` | cosmetic | Collapses to 2 hostless `details` slots; free with the WM-layer port. |
| `client/connection` | **no loss** | Transport rewritten; search card models relocated to presentation. Close it. |
| `session-persistence` | **gain + risk** | v0→v4 migration chain ships as four packages. See the gate below. |
| `client/ui-primitives` | untriaged | Evidence suggests it absorbed code (it gained `SearchBlock`). |

## Session-migration gate (data safety)

`SESSION_FORMAT_VERSION` is **0** in our live logs (verified: `{"type":"session","version":0,…}`) and **4** on the port. Migration is one-way by repo policy. The live home holds **1,791 session logs across 27 workspace directories, 1.7 GB**.

- A format-0 backup exists at `~/Library/Application Support/Anton/dsh/sessions.format0.backup-20261102`.
- **Smoke the ported runtime only against a copied home** (`DSH_HOME=/tmp/dsh-home-probe`). Do not let a first port boot touch the live home. This gates any Mac-app work.

## Phase 1 — Visual baseline (partly done)

Shell/theme/layout captured at three viewports. **Outstanding:** conversation view, tool cards, settings panes, theme variants, additive faces. `--headless=old` is required.

## Phase 2 — Base established ✅

## Phase 3 — Port the additive packages (21 of 30)

1. ✅ `context/resume-note`, `guard/gate-policy` (+ `plan_write` pulled forward).
2. ✅ 8 `llm/llm-*` providers (+ a justified widening of upstream `llm-pi-ai`'s index).
3. ✅ `subagent/model-intel`, `interaction/agent-queue` + tool, `lifecycle/tool-anton-lifecycle`, `zai/tool-zai`, `web/web-search-browser`.
4. ✅ `flowbuilder/*` (4 packages).
5. **10 `client/ui-*` faces — 1 done, 9 gated on Phase 4.** `ui-efficiency-discipline` is ported. The 5 media faces need `file.view`/`terminal.view`/`webcam.view`, which are **ours**, added by the window-manager-frame change (0 at fork, 2 in our tree, 0 upstream) — confirmed independently; upstream's `sidebar-files`/`sidebar-terminal` are a different surface. The 4 conversation faces call `ctx.get('connection').api.<ns>` from the deleted `host/apiproxy` (67 files, 5,198 insertions).
6. `apps/anton-bridge`. **Do not forward-port `3a1fadfd6c` / `4e845d6bde` verbatim** — both describe continuable behaviour the port lacks (`run_in_background` durable ids, settle notices, the `subagent-child-model` default). Port the continuable seam first or rewrite both against upstream's delegation surface.
7. Adopt upstream `preset/agent-preset`; port our preset rows. The live Blueant preset needs fixes: `backgroundMode: continuable` (line 180) is not a Config field on the port, and `deployment:persona` was renamed `deployment:persona-prefix` — confirm prepend-vs-replace semantics before trusting it, since our preset relies on a per-child persona.

## Phase 4 — Re-apply the curated modification set

Two items are **prerequisites for group 5**:

1. **Client visual layer** (`ui-layout` window-manager frame + the three view slots) — unblocks the 5 media faces.
2. **Our client↔host RPC surface as typert remote controllers** — unblocks the 4 conversation faces.
3. Restore the two `core/tools` losses: they are self-contained, need no WM layer, and are the cheapest real-capability wins — port main's paged-mode module plus the `presentAs`/`ToolPresentationMode` surface, and re-register `tools:working-discipline`.
4. Triage the remaining non-client modifications; drop 0.1.x-only adaptations.
5. `client/runtime`, `client/schema-form`, `client/web-react` existed at the fork — **upstream packages we modified**, not additive. Upstream relocated the client half of `client/runtime` into `packages/api/session-controller/src/client/` (same layout; `ordered-baseline.ts` byte-identical; `ISessions` declared and provided there). **Do not port it as a sessions implementation.**

## Phase 5 — Visual verification (acceptance gate)

Rebuild, re-capture every Phase 1 view, diff against baseline, verify every additive face mounts.

## Phase 6 — Superagent absorption

Install `dsh-superagent` as a bundle via `plugin-manager`; supply the profile `stateDir`; configure GitHub, leave Feishu disabled; validate GitHub request → ticket → session.

## Phase 7 — Rename (last)

Rename root identity and directory to antoncode-harness; update bridge paths, the `anton` launcher, `~/.anton/dsh`. **Do not rebuild the Mac app.**

## Known debt

- `subagent/model-intel` ships no tests (pre-existing).
- Regenerating `${DSH_HOME}/.agent-presets/<id>/agent.cordis.yml` **drops rows absent from the generator's tail**; the generator (`apps/anton-bridge/src/blueant-preset.ts` on main) does not exist on this branch.
- `session-persistence` write-behind (`PersistenceCoordinator`, `SessionWriteBehind`) is **unverified**, not confirmed lost: the port has `batch`/`flush` in some form.

## Fallback

`anton-pre-merge` holds the old tree; `merge/upstream-0.2` holds the staged merge. Nothing done here is destructive.