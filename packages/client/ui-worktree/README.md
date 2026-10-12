# @deepseek-ai/dsh-client-ui-worktree

The worktree surface: per-repository workspace-mode selection and live repo status in the web GUI.

## Model Experience

- **Token cost:** none. Both surfaces read the browser-side workspaces projection and the `worktree.*` wire domain; nothing they render enters a model request.
- **User-visible behavior:**
  - `ComposerContextBar` occupies the composer's tool row (`conversation.input.left`, beside the access select) as one workspace selector: the trigger is the session's location (the worktree's display name — the alias claimed from its titling session when one has claimed it, else the directory basename — when the cwd is a registered worktree, the branch otherwise), and opening it re-queries status and shows the next-session mode default under its heading — Current checkout / New worktree / one row per existing worktree by display name below "This session: …" and "Default for new sessions in …". The base-ref picker (`From <base>`) stays a separate chip whose choice is stored with the per-repository preference and wins at worktree creation — storing a base alone never changes the mode, and without a chosen base the host falls back to origin/main, then HEAD.
  - The menu rows carry the repository's default for NEW sessions, never a property of the open session: a git repository with no stored preference shows and applies the effective default (a fresh worktree per session), the heading names that meaning ("Default for new sessions in …"), and the "This session" heading keeps the location fact visually separate from the preference rows.
  - `RepoStatusChip` leads the session header's static band (`conversation.session.header.actions`, negative order): the worktree name (branch in the tooltip) when the session's cwd is a registered worktree, the branch otherwise, plus a `Stash N` badge — re-queried when the session goes idle and on click. Non-repository directories render nothing.
- **KV cache:** no interaction with model requests.

## Composition

Entries register through `ctx.slots.inject` into the ui-conversation-declared slots; live state (worktree projection, session summaries) comes from the standard `useWorkspaces` / `useSessions` seats, and the inject faces carry only `setMode` / `refresh` / `status` over `ctx.workspaces`. Copy lives in the `worktree` locale namespace (zh + en).

## Known Limitations and Deferred Work

- The select writes only the per-repository default; it does not create a worktree immediately — creation happens when the next New Session runs under the `new` mode (stored, effective-default, or explicit).
- The effective default and the whole intercept live client-side in the runtime's New Session action: sessions birthed outside it (CLI, ACP, automation) never get worktree isolation. A host-side interception point is the deferred fix.
- The chip renders for the session's cwd only; it does not watch the filesystem, so external branch switches between turns stay stale until the next idle transition or click.
- Worktree entries list branches, not commit health; ahead/behind counts are not shown yet.
- The context bar and the header chip each query `worktree.status` for the same cwd (mount, idle edge, click); the duplicate wire reads are cheap local git calls, and a shared object-layer status projection in the runtime is the deferred cleanup.
- The base picker lists remote-tracking branches (capped 12) plus `HEAD`; local-only branches are not offered as bases.
