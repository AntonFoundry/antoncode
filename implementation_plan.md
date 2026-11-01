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

A ported package without a bundle row is **inert**. Verify with `pnpm run build` (10 gates), never `tsc -b <pkg>` — a per-package build compiles only `src`, and vitest does not typecheck, so test and composition failures stay invisible. Subpath rows need a hand-written `tsconfig.base.json` alias, outside the generated block.

## Phase 2 — Base ✅

## Phase 3 — Port the additive packages (21 done)

1. ✅ gate-policy, resume-note (+ `plan_write`).
2. ✅ 8 `llm-*` providers (+ a justified additive widening of upstream `llm-pi-ai`'s index).
3. ✅ model-intel, agent-queue + tool, tool-anton-lifecycle, tool-zai, web-search-browser.
4. ✅ flowbuilder ×4.
5. **Client faces: 1 of 10 done.** `ui-efficiency-discipline` ported, mounted, carrying the restored `tools:working-discipline` sections.
6. `apps/anton-bridge` — do **not** forward-port `3a1fadfd6c`/`4e845d6bde` verbatim; both describe continuable behaviour the port lacks.
7. Adopt upstream `preset/agent-preset`; fix the live preset's 3 invalid rows.

## Phase 4 — Curated modifications (in progress)

### 1. WM visual layer — route (a) done; 69 type errors down to 1

**Decision: port it, not package it.** 20 WM files (8,916 lines) plus `WmFrame.tsx` couple to the tree through only two imports, so packaging would reproduce 9,000 lines behind a new boundary to no benefit, and the frame belongs in `ui-layout` where the slot vocabulary lives. `WmFrame.tsx` (2,205 lines) gets split **after** the port lands (approved).

**Route (a) implemented and it removed the cycle.** `ui-layout` now declares a local `WorkspaceNavigation` interface for the four members it calls (`openSession`, `startSession`, `listDirectory`, staged-session sync) and reads it through `ctx.get('uiWorkspace')`. No reference edge, so no cycle — the `ui-conversation` errors are gone. The signatures mirror `UiWorkspace` in `packages/client/ui-workspace/src/client/navigation.ts`; change both together.

**Also done and verified:** orphaned `AppFrame`/`DocumentTitle`/`shortcut-locales` deleted; `ClientContext`/`defineStore` re-pointed; `SessionId` from `dsh-session/types`; icons `…16` → `…Medium`; `ThemeSyntaxPalette` + `ThemeDefinition.syntax` restored to `ui-theme`; `SessionListState.current` replaced by a `mainSessionIdOf` derivation over `retainedBy.mainView`; `restoreBootDefault` → `setTheme`; `DirectoryEntry.isDirectory` checks dropped (upstream's browse listing is directories-only — the files buffer needs `workspaceFiles.list` to show files again); `CodeBlock` copy labels supplied; `readTextFile` reads `remote.workspaceFiles.read` and returns `{ content, truncated }`; the `conversation` slot declares `hookContext: { scopeSessionId }` and each pane passes its own binding, falling back to the main view.

**The one remaining error is a frame-assembly decision.** Our frame registers into `root` with `store: createLayoutStore` **plus** an `inject` carrying the wm and scratch stores. Upstream's `inject` is the face a **parent** registration supplies through its child declaration — not something a registrant provides for itself — and `root` is seeded by the core, so it has no parent to carry one. Upstream's own frame instead pre-creates the store instance and wraps the handle so `create()` returns it (`/tmp/upstream-layout/client/index.ts`), giving the registrant actions and observable sources with no inject face at all.

**Next step: fold the wm and scratch state into the frame's single store** using that pre-created-instance pattern, and take the ~24 injected members from the store's actions and sources. Bounded, but it changes how `WmFrame` receives its state, so it is a real refactor rather than a rename.

**Correction worth keeping:** I first added a `RootInjectFace` to `ui-renderer` to make the inject face declarable. That was a misreading of whose face `inject` is, and it was reverted — `ui-renderer` is untouched.

**Checkpoint: `/tmp/wm-inprogress`** (34 files, including the `ui-theme` and `tsconfig.base.json` changes, prefixed `_`). The branch is green, not left failing.

### Remaining Phase 4 items

2. **Re-express the client↔host RPC as typert controllers** — unblocks the 4 conversation faces. `host/apiproxy` is deleted upstream; our additions were 67 files / 5,198 insertions.
3. Replace **57 `as unknown` casts** with `snapshotJsonValue` (29 src / 28 tests). The gate is one-directional: fix, do not baseline.
4. Port main's **paged tool presentation** (`presentAs`, `ToolPresentationMode`, `renderToolsCatalog`, `TOOL_SEARCH_NAME`).
5. Decide the **continuable-subagent seam**: port it, or rewrite delegation against upstream.
6. `client/runtime`, `schema-form`, `web-react` are upstream packages we modified; upstream relocated the client half of `client/runtime` into `api/session-controller`. Port only the additive remainder.

### Why the 9 remaining faces are blocked

- **5 media faces** need `file.view`/`terminal.view`/`webcam.view` — ours, added by the WM change. Unblocked by item 1.
- **4 conversation faces** need the deleted apiproxy's `api.<ns>` surface. Unblocked by item 2.

## Verified capability losses

| area | status | detail |
|---|---|---|
| `subagent` + `tool-subagent` | **CRITICAL** | No continuable concept (5 symbols, 0 files). Config has 6 fields. Live preset line 180 invalid. |
| `core/tools` | **BEHAVIOURAL** | Paged presentation gone (4 symbols, 0 files). `tools:working-discipline` **restored**. |
| `client/ui-conversation` | cosmetic | 2 hostless `details` slots; free with the WM layer. |
| `client/connection` | no loss | Transport rewritten; models relocated to presentation. |
| `session-persistence` | gain + risk | v0→v4 chain ships. Gate below. |

## Session-migration gate

`SESSION_FORMAT_VERSION` is 0 in our live logs (verified) and 4 on the port; migration is one-way. Live home: **1,791 logs, 27 workspace dirs, 1.7 GB**. Backup: `…/sessions.format0.backup-20261102`. **Smoke only against a copied `DSH_HOME`.**

## Phase 1 — Visual baseline (outstanding)

Conversation view, tool cards, settings panes, theme variants, additive faces. `--headless=old`.

## Phase 5 — Visual acceptance (must run before trusting the WM layer)

## Phase 6 — Superagent via `plugin-manager` bundle · ## Phase 7 — Rename (last; no Mac app rebuild)

## Known debt

- `model-intel` ships no tests.
- Non-English locale strings (19 packages + client dictionaries) are mine and want translation review.
- Regenerating a preset `agent.cordis.yml` drops rows absent from the generator's tail.
- `session-persistence` write-behind is unverified, not confirmed lost.
- `WmFrame.tsx` is 2,205 lines; split it after the port lands (approved).