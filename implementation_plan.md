# Anton on upstream 0.2.2 — port, not merge

## Decision

**Rebuild Anton on upstream `0.2.2-alpha.2` by porting our 30 additive packages onto an upstream-descended branch.** The staged-merge path is abandoned; `merge/upstream-0.2` and tag `anton-pre-merge` are retained as references.

Chosen on measurement: trial merges give 5,939 conflicted files at `0.1.7-rc.2` and 5,909 at `0.2.2-alpha.2`, so staging re-resolves the same structural set four times. A merge would settle 2,515 conflicts to preserve 1,697 modified files of which **1,152 are markdown**; only ~407 are real source. Upstream also **rewrote `packages/client`**, so three-way merging our 0.1.x client edits into a rewritten client can **compile while silently changing appearance**.

The branch descends from `upstream-dsh-v0.2.2-alpha.2`, so future `git merge upstream/master` stays near-clean permanently.

## Hard constraint

**The UI's look and feel must not change.** Verified against `.anton-visual-baseline/`, not assumed.

## Current state (verified)

- Branch `anton/on-0.2.2` = upstream `0.2.2-alpha.2` + the visual-baseline commit. Working tree clean.
- **Bare upstream base builds green: 10/10 gates**, after clearing stale 0.1.x residue (`git clean -df packages apps`, remove `tsconfig.*.tsbuildinfo`, `pnpm run clean`). The initial TS6307 `host aggregate check` failure was that residue, not upstream breakage.
- **Upstream test baseline on this machine: 24 failed / 50,670 passed (14 of 2,504 files).** Compare against this, never zero. (Our old tree's baseline was 9 failures — a different tree, not comparable.)
- Node 26.13.0 satisfies upstream `>=24.9.0`; pnpm 11.28.5.
- **Zero package-name collisions** between our 30 packages and upstream's 369.
- Safety refs: `anton-pre-merge` = `8444d4c7e5`; `merge/upstream-0.2` = `60080b9bda`.

## Porting recipe (derived from a trial port of gate-policy + resume-note)

Per package, in order:

1. `git checkout anton-pre-merge -- <package path>`.
2. **Delete `src/invariant.ts`** and any `tests/invariant.spec.ts`. Upstream removed the invariants mechanism entirely — `@deepseek-ai/dsh-invariants` no longer exists, and the repo-wide "runtime invariants" rule is gone from AGENTS.md. **29 of our 30 packages carry this file.**
3. `package.json`: set `version` to `0.2.2-alpha.2`; DSH deps to `workspace:*`, vendor (`cordis`, `schemastery`, native) to `workspace:~`; drop the `./invariant` export entry and its `files` line; drop `dsh-invariants` from peer/dev deps.
4. `tsconfig.json`: remove the `../../runtime-diagnostics/invariants` reference. Every other project path we referenced still resolves (`core/tools`, `core/agent`, `core/session`, `llm/llm`, `settings/settings`).
5. `tsdown.config.ts`: drop the `lib/types/invariant.js` entry; collapse a two-entry array config to a single object.
6. Register the package in `tsconfig.host.json` (or `tsconfig.client.json` for client faces).
7. `pnpm install`, then `npx tsc -b <package path>` and fix real API drift.

### Known API drift to expect

- **`ToolGuard` is now synchronous**: `(execution) => string | undefined`. An async guard must split — pure decisions stay in the guard; anything awaiting (approval, I/O) moves to the `tools/pre-execute` waterfall, which returns `Promise<PreToolDecision>` (`packages/core/tools/src/events.ts:18`).
- **Settings was rewritten**: `installSettingsSection` / `settingsNamespace` are gone. Use the `SettingsForms` service (default export) and the `SettingsNamespace` type.
- **Session event kinds changed**: the `'plugin'` kind no longer exists, and `Session.events` is gone. Anything appending synthetic plugin events needs a new mechanism.

## Phase 1 — Visual baseline (partly done)

Shell/theme/layout captured at three viewports and committed; identity sources recorded; patch regeneration documented (`patches/` gitignored as reproducible). **Outstanding:** conversation view, tool cards, settings panes, theme variants, and the additive faces need capture from a live session. `--headless=old` is required; `--headless=new` hangs and writes nothing.

## Phase 2 — Base established ✅

## Phase 3 — Port the 30 additive packages

Apply the recipe per group, building after each group:

1. `context/resume-note`, `guard/gate-policy` — least coupled; both already trial-ported and reverted, so redo them first with the recipe.
2. 8 `llm/llm-*` providers against the 0.2.x LLM seam.
3. `subagent/model-intel`, `interaction/agent-queue` + tool, `lifecycle`, `zai`, `web/web-search-browser`.
4. `flowbuilder/*` (4 packages, includes the langflow sidecar).
5. 10 `client/ui-*` faces against the 0.2.x client UI seam.
6. `apps/anton-bridge` against the new boot/profile mechanism; verify `anton status|restart|stop|start`.
7. Adopt upstream `preset/agent-preset` (singular); port our preset rows onto it.

## Phase 4 — Re-apply the curated modification set (~407 source files)

1. Re-apply the ~163-file client visual layer deliberately against the rewritten client — port intent, never apply 0.1.x patches blindly.
2. Triage the ~244 non-client modifications; drop adaptations that existed only for 0.1.x APIs.
3. Port `host/apiproxy` 27, `subagent` 10, `llm` 8, `tool-todo` 7.
4. Prefer upstream extension points over in-place edits wherever one now exists; log every retained patch with its justification.

## Phase 5 — Visual verification (acceptance gate)

Rebuild, relaunch, re-capture every Phase 1 view with the identical command, diff against baseline, verify every additive face mounts. Unintentional change is a bug; intentional change needs sign-off.

## Phase 6 — Superagent absorption

Install `dsh-superagent` as a bundle via `plugin-manager` / `dsh.bundle.patch` (no vendoring); supply the profile `stateDir`; configure GitHub, leave Feishu disabled; translate the router/worker presets; validate GitHub request → ticket → session.

## Phase 7 — Rename (last)

Rename root identity and directory to antoncode-harness; update bridge paths, the `anton` launcher, `~/.anton/dsh`, and the app build; rebuild/reinstall the Mac app and verify boot, recovery profile, and Web GUI; document the `upstream` remote and the additive-directory convention.

## Fallback

If porting the client visual layer cannot reproduce the baseline, the old tree remains intact at `anton-pre-merge` and the staged merge on `merge/upstream-0.2` is still available. Nothing done here is destructive.