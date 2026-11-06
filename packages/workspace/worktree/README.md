---
description: "Create and track Git worktrees, inspect repository status, and retain repository workspace-mode preferences."
kind: "package-reference"
---

# @deepseek-ai/dsh-worktree

English

## Summary

Create and track separate Git worktrees, inspect repository status, and retain a repository default for future workspace selection. Created worktrees register as workspaces and survive restarts. Creation rolls back Git and workspace registration if durable storage fails; removing a worktree keeps its branch for later merging.

## Table of Contents

- [Service](#service)
- [Config](#config)
- [Durability](#durability)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Service

`WorktreeRegistry` is provided as `ctx.worktreeRegistry` (`inject: ['storageDomain', 'workspaceRegistry']`).

- `create(repoPath, { name?, base? })` — canonicalizes the repository toplevel (`git rev-parse --show-toplevel`), materializes `<repo-parent>/<repo>.worktrees/<slug>` with branch `<branchPrefix><slug>` off `base` (default: locally resolvable `origin/main`, else HEAD; an existing branch is checked out as-is for reattachment), registers the directory as a workspace (title = branch), and writes the durable record. Git runs before any durable write; a failed durable write rolls the git worktree and the workspace registration back.
- `list(repoPath?)` — newest-first records, optionally filtered to one repository.
- `status(path)` — live `{ branch, head, dirty, stashCount, ahead, behind }` for any git working directory; stash count is repo-global (stashes live in the common dir).
- `pref(repoPath)` / `setPref(repoPath, pref)` — the durable per-repository default workspace mode: `checkout`, `new`, or `reuse:<worktreeId>`.
- `aliasFromTitle(sessionId, cwd, title)` — the worktree's display alias, claimed from the first titled session running inside it and refined by that session's later titles (fallback → provider → user rename); slugified (`[a-z0-9-]`, ≤40 chars, `wt` fallback claims nothing). Display-only — paths and branches never move — and other sessions never rename a claimed worktree, so a reused one keeps its first claimant's name.
- `remove(id, { force? })` — `git worktree remove` (refuses a dirty tree unless forced) plus record deletion; the branch is never deleted, so merge-back stays possible.

## Config

| Field | Default | Meaning |
|---|---|---|
| `branchPrefix` | `agent/` | Branch namespace for created worktree branches. |
| `parentSuffix` | `.worktrees` | Sibling-directory suffix: worktrees live at `<repo-parent>/<repo><parentSuffix>/<slug>`. |

## Durability

Domain `worktree` (version 1): one `worktrees` table keyed by `WorktreeId`; the table is the registry — display order derives from record timestamps, so a single row write is the whole mutation. The global singleton holds only the per-repository mode preferences.

## Model Experience

### Worktree-backed workspaces

#### What the model sees

The `worktreeRegistry` service adds no model tool or prompt. Consumers choose a worktree as a Session working directory; the [working-directory owner](../../session/working-directory/README.md) supplies its model-visible directory context.

#### Token effect

Registry operations consume no model tokens by themselves. Tools and directory-context consumers own any rendered result or context costs.

#### KV Cache effect

Creating or inspecting a worktree does not rewrite model history. Selecting another directory can change the consuming Session's directory context.

## Known Limitations and Deferred Work

- Untracked files (`.env`, build outputs, `node_modules`) do not appear in fresh worktrees; callers surface this as a UI hint when offering New worktree.
- `node_modules` per worktree costs disk and install time; no sharing or symlink strategy exists yet.
- Worktree creation does not fetch from remotes — the default base is only as fresh as the local `origin/main`.
- Merge conflicts between agents remain a merge-time concern; isolation removes concurrent-edit corruption, not semantic conflicts.

### Dev Note

None.
