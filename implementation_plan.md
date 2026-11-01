# Anton on upstream 0.2.2 — port, not merge

## Decision

**Rebuild Anton on upstream `0.2.2-alpha.2` by porting our additive packages onto an upstream-descended branch.** The staged-merge path is abandoned; `merge/upstream-0.2` and tag `anton-pre-merge` are retained as references.

The branch descends from `upstream-dsh-v0.2.2-alpha.2`, so future `git merge upstream/master` stays near-clean permanently.

## Hard constraint

**The UI's look and feel must not change.** Verified against `.anton-visual-baseline/`, not assumed.

## Current state (verified)

- Branch `anton/on-0.2.2` = upstream `0.2.2-alpha.2` + visual baseline + 20 ported packages. **Build 10/10 gates after every group.**
- Upstream's own test baseline on this machine: **24 failed / 50,670 passed**. Compare against this, never zero.
- Safety refs: `anton-pre-merge` = `8444d4c7e5`; `merge/upstream-0.2` = `60080b9bda`.

## Porting recipe (scripted at `.anton-port/port-package.py`)

Per package: copy from `anton-pre-merge`; delete `src/invariant.ts` **and any invariant `describe` block inside a normal spec**; set version `0.2.2-alpha.2`; DSH deps `workspace:*`, vendor `workspace:~`; drop the `./invariant` export, its `files` line, and `dsh-invariants`; remove the `runtime-diagnostics/invariants` tsconfig reference; collapse the `tsdown.config.ts` invariant entry; register in `tsconfig.host.json` or `tsconfig.client.json`; run `pnpm run gen-tsconfig-paths` (the `tsconfig.base.json` alias block is **generated**); `pnpm install`; then fix drift.

**Verify with `pnpm run build` (10 gates), not `tsc -b <pkg>`.** A per-package build compiles only `src`, and vitest does not typecheck, so test-file type errors stay invisible until the host aggregate runs. Also run `npx oxlint <pkg>` (type-aware); the pre-commit hook runs a weaker non-type-aware config.

### Known API drift

- Invariants mechanism deleted; `ToolGuard` is synchronous (awaiting work moves to the `tools/pre-execute` waterfall); settings are **Config-derived** (`installSettingsSection` gone, namespace from `ctx.fiber.entry?.options.id`).
- `session.events` → `snapshotEvents()`; the `'plugin'` message source is gone (each plugin declares its own kind); tool results are their own `role:'tool'` message; `CallId` → `ToolCallId`; `tools.execute` takes a **batch** and needs an executor plugin; `agent/pre-step` carries `modelSelection`; the session header is readonly.
- `JsonValue` → `dsh-util-values`; `dsh-code-runtime` → `dsh-ptc-runtime` (`Code*` → `Ptc*`) with a `resolve`/`run` split; shell settles through `execute()` + `result()`; `SubprocessHandle.pid` is gone; `crypto.randomUUID` is restricted (use `dsh-util-crypto`); `WebFetchResult.status` → `statusCode`, text body `.text` → `.content`.
- Reading an optional service through `ctx.get` **untyped hides real drift behind `any`** — add the type-only import.

## Phase 1 — Visual baseline (partly done)

Shell/theme/layout captured at three viewports and committed. **Outstanding:** conversation view, tool cards, settings panes, theme variants, and the additive faces. `--headless=old` is required.

## Phase 2 — Base established ✅

## Phase 3 — Port the additive packages (20 of 30 done)

1. ✅ `context/resume-note`, `guard/gate-policy` (+ `plan_write`, pulled forward from Phase 4 as a dependency).
2. ✅ 8 `llm/llm-*` providers (+ a justified additive widening of upstream `llm-pi-ai`'s index).
3. ✅ `subagent/model-intel`, `interaction/agent-queue` + tool, `lifecycle/tool-anton-lifecycle`, `zai/tool-zai`, `web/web-search-browser`.
4. ✅ `flowbuilder/*` (4 packages incl. the langflow sidecar).
5. **10 `client/ui-*` faces** — next. See the corrected scope below.
6. `apps/anton-bridge` on the new boot/profile mechanism.
7. Adopt upstream `preset/agent-preset`; port our preset rows.

### Correction: three client packages are NOT additive

`client/runtime`, `client/schema-form`, and `client/web-react` **existed at the fork point** — they are upstream packages we modified, so they belong to Phase 4, not Phase 3. The additive client set is exactly the **10 `ui-*` faces**.

**Upstream relocated our client runtime.** `host/apiproxy` was deleted and split into typed `api/*` controllers plus `client/connection`; the client half of `client/runtime` now lives in `packages/api/session-controller/src/client/` with the same layout (`contract/`, `sessions/`, `ordered-baseline.ts`, `time-zone.ts`) — `ordered-baseline.ts` is byte-identical. `ISessions` is declared and provided there.

**Therefore do not port `client/runtime` as a sessions implementation.** Re-point the 10 faces at upstream's homes:

| was (`dsh-client-runtime` / `dsh-host-apiproxy`) | now |
|---|---|
| `SessionId` | `dsh-client-connection` |
| `SlotRegistry` | `dsh-client-ui-renderer` |
| `defineStore`, `EngineStoreHandle` | `dsh-client-store` |
| `SessionListState` | `dsh-client-ui-session` |
| `ChatSnapshot` | `dsh-client-ui-chat` |
| `transportError`, `RpcId` | `dsh-client-connection` |
| `SESSION_SEARCH_RESULT_LIMIT`, `ISessions` | `dsh-api-session-controller` |
| `ClientContext`, `WorkspaceListState`, `WorktreeStatusView` | still to locate |

## Phase 4 — Re-apply the curated modification set

1. Re-apply the client visual layer deliberately against the rewritten client — port intent, never 0.1.x patches.
2. Triage the non-client modifications; drop 0.1.x-only adaptations.
3. `client/runtime`, `client/schema-form`, `client/web-react`: decide per package whether upstream's relocation already carries our change, and port only the genuinely additive remainder.
4. `host/apiproxy` is **deleted upstream**; its 27 modified files are re-expressed against `api/*` + `client/connection` or dropped.
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