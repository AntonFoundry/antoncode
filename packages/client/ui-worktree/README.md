# @deepseek-ai/dsh-client-ui-worktree

The worktree surface: per-repository workspace-mode selection and live repo status in the web GUI.

## Model Experience

- **Token cost:** none. Both surfaces read the browser-side workspaces projection and the `worktree.*` wire domain; nothing they render enters a model request.
- **User-visible behavior:**
  - `ComposerContextBar` occupies the composer's tool row (`conversation.input.left`, beside the access select): the repository branch chip (re-queries on click), the workspace-mode select (`WorktreeModeSelect`: Current checkout / New worktree / Previous worktree (`<branch>`), rendered with the effective checkout default even before a preference exists), and the base-ref picker (`From <base>`) whose choice is stored with the per-repository preference and wins at worktree creation — without one the host falls back to origin/main, then HEAD.
  - `RepoStatusChip` leads the session header's static band (`conversation.session.header.actions`, negative order): branch plus a `Stash N` badge for the session cwd, re-queried when the session goes idle and on click. Non-repository directories render nothing.
- **KV cache:** no interaction with model requests.

## Composition

Entries register through `ctx.slots.inject` into the ui-conversation-declared slots; live state (worktree projection, session summaries) comes from the standard `useWorkspaces` / `useSessions` seats, and the inject faces carry only `setMode` / `refresh` / `status` over `ctx.workspaces`. Copy lives in the `worktree` locale namespace (zh + en).

## Known Limitations and Deferred Work

- The select writes only the per-repository default; it does not create a worktree immediately — creation happens when the next New Session runs under the `new` mode.
- The chip renders for the session's cwd only; it does not watch the filesystem, so external branch switches between turns stay stale until the next idle transition or click.
- Worktree entries list branches, not commit health; ahead/behind counts are not shown yet.
- The context bar and the header chip each query `worktree.status` for the same cwd (mount, idle edge, click); the duplicate wire reads are cheap local git calls, and a shared object-layer status projection in the runtime is the deferred cleanup.
- The base picker lists remote-tracking branches (capped 12) plus `HEAD`; local-only branches are not offered as bases.
