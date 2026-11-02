# Agent Note: per-session git worktree isolation + repo status

Status: implemented

## Problem

Sessions in the Anton web GUI all run inside one checkout. Parallel sessions step on each other's edits: two agents edit the same files, builds interleave, and one session's revert undoes another's fix. The user wants the competitor pattern — a workspace selector (Current checkout / New worktree / Previous worktree) beside the composer's access-mode control, a per-repo default so new sessions open in a fresh worktree, and a repo-status chip (branch + stash count) — because worktree-per-session makes the sandbox boundary, the session cwd, and the file edits line up per session.

## Decision

- **Host seam**: new package `@deepseek-ai/dsh-worktree` provides `ctx.worktreeRegistry` (`inject: ['storageDomain', 'workspaceRegistry']`). It owns git worktree lifecycle (`worktree add/list/remove/prune` via a plain `execFile` git module, no git dependency), durable per-repo records in a new `worktree` storage domain, live status (`branch/head/dirty/stashCount/ahead/behind`), and the per-repository default workspace-mode preference (`checkout | new | reuse:<id>`).
- **Worktrees are ordinary workspaces.** `worktree.create` registers the worktree directory through `ctx.workspaceRegistry` (title = branch), so every existing grouping plumbing — sidebar groups, session membership by canonical cwd — works unchanged. Records store the resulting `workspaceId`; "previous worktree" reattachment opens a NEW session in that workspace (resume stays cwd-conflict-guarded and is never attempted across worktrees).
- **Layout and naming**: worktrees live at `<repo-parent>/<repo>.worktrees/<slug>` (siblings, never nested in the checkout); branches are `<branchPrefix><slug>` (default `agent/`), created off a locally resolvable `origin/main`, else HEAD; an existing branch is checked out as-is for reattachment. Both names are `Config` fields.
- **Repo identity**: `git rev-parse --git-common-dir`'s parent canonicalizes any checkout-or-worktree directory to the same repository key, so preferences and list filters written from a worktree resolve identically to the main checkout.
- **Failure order**: git runs before any durable write; a failed registry write rolls the worktree and the workspace registration back (the commit point is the durable put). `worktree prune` runs before each add so externally deleted worktree directories cannot wedge a reattach. `remove` accepts git's not-a-working-tree complaint so stale records clear; it refuses dirty trees unless forced and never deletes branches (merge-back keeps them).
- **Wire**: `worktree.list/create/status/pref/setPref/remove` join the apiproxy RPC map beside `workspace.*`.
- **Client**: the workspaces domain (which owns New Session) gains the worktree slice — per-repo pref, worktree list, status, and the `startSession` interception that materializes a worktree before connecting the session. A git repository with no stored preference resolves to the effective default `{mode:'new'}` (one `worktree.status` repo check on the no-pref path only), so every client-born session isolates unless the user picks Current checkout; a failed worktree step falls back to the checkout connect instead of losing the New Session gesture. The UI is a new `ui-worktree` plugin package occupying the existing `conversation.input.left` (mode select) and `conversation.session.header.actions` (status chip) seats — zero ui-conversation changes. The mode select displays the next-session default with its meaning ("Default for new sessions in …" heading, semantics tooltip) so it is never mistaken for a property of the open session; the status chips name the worktree when the session cwd is a registered worktree and the branch otherwise; the sidebar prefixes a worktree workspace's sessions with `<worktree>/<title>` (display-only; durable titles stay clean).

## Alternatives considered

- **Sandbox-level copy-on-write clones** — no git history/branch story and doubles disk; worktrees share the object store.
- **Fold worktree records into the workspace domain** — conflates user-curated groupings with disposable git artifacts and drags git execution into the workspace package.
- **Host-side automatic default-mode enforcement inside `session.create`** — hides the mode behind one entry point; the client-side interception keeps `session.create` honest (cwd/workspace only) and keeps the UI in charge of surfacing creation latency.

## Consequences

- Session cwd is the sandbox workspace root, so a worktree session isolates its whole agent tree automatically (subagents inherit cwd).
- The effective default makes isolation opt-out: a repo the user never configured worktrees every new client session. The whole intercept lives client-side, so sessions birthed outside `startSession` (CLI, ACP, automation) stay unisolated — the deferred host-side interception point.
- Untracked files (`.env`, `node_modules`) do not appear in fresh worktrees; the UI option carries a hint. Disk cost per worktree is real; no sharing strategy yet.
- Merge conflicts between agents remain a merge-time concern — isolation removes concurrent-edit corruption, not semantic conflicts.
- Stash counts are repository-global (git stores stashes in the common dir), so every worktree chip of one repo shows the same number.

## Testing

`packages/workspace/worktree/tests/worktree.spec.ts` exercises the registry against real temp git repositories: create (branch/base/workspace registration), HEAD fallback, slug collision, stale-branch reattach after external deletion, base-ref verification, non-repo rejection, cross-repo list filtering/order, live status (dirty, repo-global stash count, no-upstream zeros, detached marker), preference isolation through worktree directories, clean/dirty/forced removal, durable-failure rollback, and the cache/table invariant companion in both directions. Wire schemas are validated by the apiproxy rpc-schema spec; client packages carry their own suites.
