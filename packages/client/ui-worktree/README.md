---
description: "Choose new-Session worktree defaults and inspect repository status from the composer and Session header."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-worktree

English

## Summary

Choose whether new GUI Sessions use the current checkout, a fresh worktree, or an existing worktree, and select a base reference for creation. The composer distinguishes the current Session location from the repository default for future Sessions. The header shows the worktree or branch and stash count; non-repository locations show no status chip.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Use the composer selector for future Session defaults and the header chip for the current repository status.

- `ComposerContextBar` occupies the composer's tool row (`conversation.input.left`, beside the access select) as one workspace selector: the trigger is the session's location (the worktree's display name — the alias claimed from its titling session when one has claimed it, else the directory basename — when the cwd is a registered worktree, the branch otherwise), and opening it re-queries status and shows the next-session mode default under its heading — Current checkout / New worktree / one row per existing worktree by display name below "This session: …" and "Default for new sessions in …". The base-ref picker (`From <base>`) stays a separate chip whose choice is stored with the per-repository preference and wins at worktree creation — storing a base alone never changes the mode, and without a chosen base the host falls back to origin/main, then HEAD.
  - The menu rows carry the repository's default for NEW sessions, never a property of the open session: a git repository with no stored preference shows and applies the effective default (a fresh worktree per session), the heading names that meaning ("Default for new sessions in …"), and the "This session" heading keeps the location fact visually separate from the preference rows.
- `RepoStatusChip` leads the session header's static band (`conversation.session.header.actions`, negative order): the worktree name (branch in the tooltip) when the session's cwd is a registered worktree, the branch otherwise, plus a `Stash N` badge — re-queried when the session goes idle and on click. Non-repository directories render nothing.

-----

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Entries register through `ctx.slots.inject` into the ui-conversation-declared slots; live state (worktree projection, session summaries) comes from the standard `useWorkspaces` / `useSessions` seats, and the inject faces carry only `setMode` / `refresh` / `status` over `ctx.workspaces`. Copy lives in the `worktree` locale namespace (zh + en).

</details>

-----

## Model Experience

### Workspace selection

#### What the model sees

The `conversation.input.left` and `conversation.session.header.actions` contributions add no model-facing text. New-Session worktree selection changes where the Session starts; the [working-directory owner](../../session/working-directory/README.md) supplies any resulting directory context.

#### Token effect

The controls add no prompt tokens; directory context follows the Session working-directory contribution.

#### KV Cache effect

Changing a future Session location can change its directory context; merely opening a selector or refreshing status changes no provider request.

## Known Limitations and Deferred Work

- The select writes only the per-repository default; it does not create a worktree immediately — creation happens when the next New Session runs under the `new` mode (stored, effective-default, or explicit).
- The effective default and the whole intercept live client-side in the runtime's New Session action: sessions birthed outside it (CLI, ACP, automation) never get worktree isolation. A host-side interception point is the deferred fix.
- The chip renders for the session's cwd only; it does not watch the filesystem, so external branch switches between turns stay stale until the next idle transition or click.
- Worktree entries list branches, not commit health; ahead/behind counts are not shown yet.
- The context bar and the header chip each query `worktree.status` for the same cwd (mount, idle edge, click); the duplicate wire reads are cheap local git calls, and a shared object-layer status projection in the runtime is the deferred cleanup.
- The base picker lists remote-tracking branches (capped 12) plus `HEAD`; local-only branches are not offered as bases.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
