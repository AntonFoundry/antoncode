# Anton on upstream 0.2.2 — port, not merge

## Decision

**Rebuild Anton on upstream `0.2.2-alpha.2` by porting our additive packages onto an upstream-descended branch.** Staged merging is abandoned; `merge/upstream-0.2` and tag `anton-pre-merge` are retained as references.

## Hard constraints

1. **The UI's look and feel must not change** — verified against `.anton-visual-baseline/`, not assumed.
2. **Never boot the ported runtime against the live `DSH_HOME`** (see the migration gate).

## Current state (verified)

**Build 10/10 gates · `verify-cordis-config` 305 files · tree clean · 26 suite failures vs the 24 upstream baseline, none in a ported package.**

21 of 30 additive packages ported **and mounted**. Safety refs: `anton-pre-merge` = `8444d4c7e5`, `merge/upstream-0.2` = `60080b9bda`.

## Porting is two steps: port AND compose

A ported package without a bundle row is **inert**. Verify with `pnpm run build` (10 gates), never `tsc -b <pkg>` — a per-package build compiles only `src`, and vitest does not typecheck, so test and composition failures stay invisible. Subpath rows need a hand-written `tsconfig.base.json` alias.

## Phase 2 — Base ✅

## Phase 3 — Port the additive packages (21 done)

1. ✅ gate-policy, resume-note (+ `plan_write`).
2. ✅ 8 `llm-*` providers (+ a justified additive widening of upstream `llm-pi-ai`'s index).
3. ✅ model-intel, agent-queue + tool, tool-anton-lifecycle, tool-zai, web-search-browser.
4. ✅ flowbuilder ×4.
5. **Client faces: 1 of 10 done.** `ui-efficiency-discipline` is ported, mounted, and now carries the restored `tools:working-discipline` sections.
6. `apps/anton-bridge` — do **not** forward-port `3a1fadfd6c`/`4e845d6bde` verbatim; both describe continuable behaviour the port lacks.
7. Adopt upstream `preset/agent-preset`; fix the live preset's 3 invalid rows.

## Phase 4 — Curated modifications (in progress)

1. **WM visual layer — STARTED, ~90% ported, needs one API port.** 20 WM files (8,916 lines) + `WmFrame.tsx` are copied in, reconciliations already done: `AppFrame`/`DocumentTitle`/`shortcut-locales` removed as orphaned; `ClientContext`/`SessionId`/`defineStore` re-pointed; `ThemeSyntaxPalette` + `ThemeDefinition.syntax` restored to `ui-theme`; icons renamed (`…16` → `…Medium`); `'root'` merge imported; project-reference **cycle** avoided by typing `useSessions`/`useWorkspaces` through `UseSessions`/`WorkspaceSnapshot` rather than `GlobalStandardProps`.
   **Remaining: 24 type errors, one real API port.** Our frame assumes 0.1.x controller shapes: `SessionListState.current` (11 uses — upstream moved *view selection out of the sessions controller*, so it no longer exists by design), `ISessions.open`/`setStaged`, `IWorkspaces.startSession`/`listDirectory`/`readTextFile`/`openPath`, `ThemeRuntime.restoreBootDefault`, `DirectoryEntry.isDirectory`. Re-express these against the 0.2.x surfaces, chiefly `ctx.uiSession` bindings.
   **Checkpoint: `/tmp/wm-inprogress`** (24 files + tsconfig). The branch was restored to green rather than left failing.
2. **Re-express the client↔host RPC as typert controllers** — unblocks the 4 conversation faces. `host/apiproxy` is deleted upstream; our additions there were 67 files / 5,198 insertions.
3. Replace **57 `as unknown` casts** with `snapshotJsonValue` (29 src / 28 tests); the gate is one-directional, so they must be fixed, not baselined.
4. Port main's **paged tool presentation** (`presentAs`, `ToolPresentationMode`, `renderToolsCatalog`, `TOOL_SEARCH_NAME`).
5. Decide the **continuable-subagent seam**: port it, or rewrite delegation against upstream.
6. `client/runtime`, `schema-form`, `web-react` are upstream packages we modified — upstream relocated the client half of `client/runtime` into `api/session-controller` (`ordered-baseline.ts` byte-identical, `ISessions` provided there). Port only the additive remainder.

### Why the 9 remaining faces are blocked

- **5 media faces** need `file.view`/`terminal.view`/`webcam.view` — ours, added by the WM change (0 at fork, 2 in our tree, 0 upstream). Unblocked by item 1.
- **4 conversation faces** need `ctx.get('connection').api.<ns>` from the deleted apiproxy. Unblocked by item 2.

## Verified capability losses

| area | status | detail |
|---|---|---|
| `subagent` + `tool-subagent` | **CRITICAL** | No continuable concept: `startContinuable`, `registerContinuableSetup`, `reportFrom`, `drainContinuableDescendants`, `backgroundMode` all 0 files. Config has 6 fields (`agentOptions`/`maxDepth` survive). Live preset line 180 is invalid. |
| `core/tools` | **BEHAVIOURAL** | Paged presentation gone (4 symbols, 0 files). `tools:working-discipline` **restored** — always-on, with its toggle gating only the economy framing. |
| `client/ui-conversation` | cosmetic | 2 hostless `details` slots; free with the WM layer. |
| `client/connection` | no loss | Transport rewritten; models relocated to presentation. |
| `session-persistence` | gain + risk | v0→v4 chain ships. Gate below. |

## Session-migration gate

`SESSION_FORMAT_VERSION` is 0 in our live logs (verified) and 4 on the port; migration is one-way. Live home: **1,791 logs, 27 workspace dirs, 1.7 GB**. Backup exists at `…/sessions.format0.backup-20261102`. **Smoke only against a copied `DSH_HOME`.**

## Phase 1 — Visual baseline (outstanding)

Conversation view, tool cards, settings panes, theme variants, additive faces. `--headless=old`.

## Phase 5 — Visual acceptance (must run before trusting the WM layer)

## Phase 6 — Superagent via `plugin-manager` bundle · ## Phase 7 — Rename (last; no Mac app rebuild)

## Known debt

- `model-intel` ships no tests.
- Non-English locale strings (19 packages + client dictionaries) are mine and want translation review.
- Regenerating a preset `agent.cordis.yml` drops rows absent from the generator's tail.
- `session-persistence` write-behind is unverified, not confirmed lost.