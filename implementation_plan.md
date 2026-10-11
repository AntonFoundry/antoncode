# Worktree selector: default-new sessions, clear semantics, meaningful names

## Goal
Make the web client's workspace flow behave as the user described: every new chat starts in a fresh git worktree by default (opt-out via explicit "Current checkout"), the choice is labeled as what it is (the per-repo default for the NEXT session, not the current session's property), and the current session's workspace (worktree + name vs main checkout) is visible at a glance. Scope is the client surface (`packages/client/ui-worktree`, `ui-layout`, `runtime` workspaces service); the host-side intercept for CLI/ACP sessions is explicitly out of scope this pass.

## Phases
1. **Effective-mode resolution in the runtime (default `new`)** — one named resolution point in `workspaces/service.ts`: stored pref wins; no pref + git repository → `{mode:'new'}`; not a repo → checkout. `startSession` consumes it (with a `worktree.status` repo check only on the no-pref path, and a create-failure fallback to the checkout connect that matches the documented contract); `chooseBase` stops writing `mode:'checkout'` as a side effect (preserve effective mode when storing a base).
2. **Selector semantics + indication (ui-worktree)** — `WorktreeModeSelect` mirrors the effective default and carries a "default for NEW sessions in this repo" label (menu heading + tooltip/aria); session chips get worktree-vs-main labeling by resolving the session cwd against the worktree projection (slug + repo), so the currently viewed session's own workspace is never confused with the pref again.
3. **Meaningful worktree names** — thread an optional user-supplied name into the New Session flow (the create API already accepts `name`; today it is a `wt-<timestamp>` slug with no UI). Smallest seam: a name field at the point a `new`-mode session is started; timestamp slug stays the fallback.
4. **Verification & docs** — component + runtime tests to the 100% client coverage gate, `pnpm run test:gui`, `DSH_SNAPSHOT=replay pnpm run test:web` if assembled output changes, README updates (`worktree`, `ui-worktree`), Agent Note, conventional commits.

## Known context (from the completed analysis)
- Pref is durable per-repo (`checkout|new|reuse`), written at pick time (`WorktreeModeSelect.tsx:120-135` → `worktree.setPref`), consumed only by client-side `startSession` (`service.ts:226-276`).
- Selector display re-derives from the active session's cwd (`WorktreeModeSelect.tsx:81-95,137`) — the "flip" is correct behavior, unlabeled.
- Worktree slug is auto `wt-YYYYMMDD-HHMMSS` (`worktree/src/index.ts:318-323`); `createWorktree` accepts `name` (`service.ts:318-320`), no UI passes it.
- Sidebar already prefixes worktree-workspace sessions with the worktree name (`WorkspaceBrowser.tsx:838-841`).
- c0ntext engine down — code-first.