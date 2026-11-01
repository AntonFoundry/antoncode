# Anton on upstream 0.2.2 — port, not merge

## Decision

**Rebuild Anton on upstream `0.2.2-alpha.2` by porting our additive packages onto an upstream-descended branch.** The staged-merge path is abandoned; `merge/upstream-0.2` and tag `anton-pre-merge` are retained as references.

The branch descends from `upstream-dsh-v0.2.2-alpha.2`, so future `git merge upstream/master` stays near-clean permanently.

## Hard constraint

**The UI's look and feel must not change.** Verified against `.anton-visual-baseline/`, not assumed.

## Current state (verified)

- Branch `anton/on-0.2.2` = upstream `0.2.2-alpha.2` + visual baseline + **21 ported packages**. **Build 10/10 gates after every group.**
- Upstream's own test baseline on this machine: **24 failed / 50,670 passed**. Compare against this, never zero.
- Safety refs: `anton-pre-merge` = `8444d4c7e5`; `merge/upstream-0.2` = `60080b9bda`.

## Porting recipe (scripted at `.anton-port/port-package.py`)

Per package: copy from `anton-pre-merge`; delete `src/invariant.ts` **and any invariant `describe` block inside a normal spec**; set version `0.2.2-alpha.2`; DSH deps `workspace:*`, vendor `workspace:~`; drop the `./invariant` export, its `files` line, and `dsh-invariants`; remove the `runtime-diagnostics/invariants` tsconfig reference; collapse the `tsdown.config.ts` invariant entry; register in `tsconfig.host.json` / `tsconfig.client.json`; run `pnpm run gen-tsconfig-paths` (that alias block is **generated**); `pnpm install`; then fix drift.

**Verify with `pnpm run build` (10 gates), not `tsc -b <pkg>`.** A per-package build compiles only `src`, and vitest does not typecheck, so test-file type errors stay invisible until the aggregates run. Also run `npx oxlint <pkg>` (type-aware); the pre-commit hook runs a weaker non-type-aware config.

### Known API drift

- Invariants deleted; `ToolGuard` is synchronous (awaiting work moves to the `tools/pre-execute` waterfall); settings are **Config-derived** (`installSettingsSection` gone, namespace from `ctx.fiber.entry?.options.id`).
- `session.events` → `snapshotEvents()`; the `'plugin'` message source is gone (each plugin declares its own kind); tool results are their own `role:'tool'` message; `CallId` → `ToolCallId`; `tools.execute` takes a **batch** and needs an executor plugin; `agent/pre-step` carries `modelSelection`; the session header is readonly.
- `JsonValue` → `dsh-util-values`; `dsh-code-runtime` → `dsh-ptc-runtime` (`Code*` → `Ptc*`) with a `resolve`/`run` split; shell settles through `execute()` + `result()`; `SubprocessHandle.pid` is gone; `crypto.randomUUID` is restricted (use `dsh-util-crypto`); `WebFetchResult.status` → `statusCode`, text body `.text` → `.content`.
- Reading an optional service through `ctx.get` **untyped hides real drift behind `any`** — add the type-only import.

### Client-face drift (from the first ported face)

- Client packages use **split compiler faces**: solution-only `tsconfig.json` + `tsconfig.host.json` / `tsconfig.client.json` leaves; dependents reference the **leaf**, and so do the aggregates.
- `clientBundle(import.meta.dirname, …)`, not the package name.
- `ClientContext` was our own re-export — use cordis `Context`. `defineStore`/`EngineStoreHandle` → `dsh-client-store`; `ctx.slots` → `dsh-client-ui-renderer`; `SessionListState` → `dsh-client-ui-session`; `ChatSnapshot` → `dsh-client-ui-chat`; `SessionId`/`transportError`/`RpcId` → `dsh-client-connection`; `WorkspaceView` → `dsh-api-workspace-controller`; `SessionSummary`/`ISessions`/`SESSION_SEARCH_RESULT_LIMIT` → `dsh-api-session-controller`.
- Client settings: host declares its own `Config` and `ctx.settings.configure({ auto })`; the browser half reads `ctx.configForms.get<T>(namespace)`.

## Phase 1 — Visual baseline (partly done)

Shell/theme/layout captured at three viewports. **Outstanding:** conversation view, tool cards, settings panes, theme variants, and the additive faces. `--headless=old` is required.

## Phase 2 — Base established ✅

## Phase 3 — Port the additive packages (21 of 30)

1. ✅ `context/resume-note`, `guard/gate-policy` (+ `plan_write`, pulled forward as a dependency).
2. ✅ 8 `llm/llm-*` providers (+ a justified additive widening of upstream `llm-pi-ai`'s index).
3. ✅ `subagent/model-intel`, `interaction/agent-queue` + tool, `lifecycle/tool-anton-lifecycle`, `zai/tool-zai`, `web/web-search-browser`.
4. ✅ `flowbuilder/*` (4 packages incl. the langflow sidecar).
5. **10 `client/ui-*` faces — 1 done, 9 blocked on Phase 4 work.** See below.
6. `apps/anton-bridge` on the new boot/profile mechanism.
7. Adopt upstream `preset/agent-preset`; port our preset rows.

### Group 5 is gated, not merely hard

- ✅ `ui-efficiency-discipline` — needed no RPC and no custom slot.
- **5 media faces** (`ui-file-image`, `ui-file-markdown`, `ui-file-video`, `ui-terminal`, `ui-webcam`) register into `file.view` / `terminal.view` / `webcam.view`. Those slots are **our additions to upstream `ui-layout`** (absent at the fork and absent upstream), declared by the same change that replaces the layout with the window-manager frame. **They are blocked on the Phase 4 client visual layer.**
- **4 conversation faces** (`ui-conversation-agent-mail`, `ui-flowbuilder`, `ui-orchestrator`, `ui-worktree`) call the host through `ctx.get('connection').api.<ns>.<method>` — the `IApiClient` map we added to the deleted `host/apiproxy` (**67 files, 5,198 insertions**). Upstream replaced apiproxy with 6 typert controllers reached as `ctx.remote.<controller>`. **They are blocked on re-expressing our RPC surface as typert remote controllers.**
- `WorkspaceListState`, `WorktreeStatusView`, `WorktreeModePrefView` exist only in our tree; they belong with `ui-worktree`, which uses them.

## Phase 4 — Re-apply the curated modification set

Two items are now **prerequisites for Phase 3 group 5**, so they come first:

1. **Client visual layer** (`ui-layout` window-manager frame + the three view slots) — unblocks the 5 media faces. Port intent against the rewritten client, never 0.1.x patches; verify against the baseline.
2. **Our client↔host RPC surface as typert remote controllers** — unblocks the 4 conversation faces. `host/apiproxy` is deleted upstream; re-express the namespaces our faces call (`orchestrator`, `flow`, mail, worktree) or drop them.
3. Triage the remaining non-client modifications; drop 0.1.x-only adaptations.
4. `client/runtime`, `client/schema-form`, `client/web-react` existed at the fork and are **upstream packages we modified**, not additive. Upstream relocated the client half of `client/runtime` into `packages/api/session-controller/src/client/` (same layout; `ordered-baseline.ts` byte-identical; `ISessions` declared and provided there). **Do not port it as a sessions implementation** — that would duplicate a contract upstream owns.
5. Prefer upstream extension points over in-place edits; log every retained patch with its justification.

## Phase 5 — Visual verification (acceptance gate)

Rebuild, re-capture every Phase 1 view, diff against baseline, verify every additive face mounts. Unintentional change is a bug; intentional change needs sign-off.

## Phase 6 — Superagent absorption

Install `dsh-superagent` as a bundle via `plugin-manager` (no vendoring); supply the profile `stateDir`; configure GitHub, leave Feishu disabled; validate GitHub request → ticket → session.

## Phase 7 — Rename (last)

Rename root identity and directory to antoncode-harness; update bridge paths, the `anton` launcher, `~/.anton/dsh`. **Do not rebuild the Mac app.**

## Known debt

- `subagent/model-intel` ships no tests (pre-existing gap, not introduced by the port).

## Fallback

The old tree remains intact at `anton-pre-merge`; the staged merge survives on `merge/upstream-0.2`. Nothing done here is destructive.