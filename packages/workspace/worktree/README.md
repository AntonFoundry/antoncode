# @deepseek-ai/dsh-worktree

Git worktree registry for the DeepSeek Harness: per-repository worktree lifecycle, live repo status, and the per-repository default workspace-mode preference.

## Model Experience

- **Token cost:** none. The registry is host-side infrastructure; nothing it does enters a model request, and it registers no system-prompt section.
- **User-visible behavior:** the `worktree.*` wire domain backs the web UI's workspace-mode selector (Current checkout / New worktree / Previous worktree) and repo-status chip (branch + stash count). Sessions opened in a worktree run with the worktree directory as their cwd — and therefore as their sandbox workspace boundary — so parallel sessions in separate worktrees never write to the same checkout.
- **KV cache:** no interaction with model requests.

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

Domain `worktree` (version 1): one `worktrees` table keyed by `WorktreeId`; the table is the registry — display order derives from record timestamps, so a single row write is the whole mutation. The global singleton holds only the per-repository mode preferences. Invariant companion `worktree-invariant` asserts the record cache mirrors the durable table in both directions.

## Known Limitations and Deferred Work

- Untracked files (`.env`, build outputs, `node_modules`) do not appear in fresh worktrees; callers surface this as a UI hint when offering New worktree.
- `node_modules` per worktree costs disk and install time; no sharing or symlink strategy exists yet.
- Worktree creation does not fetch from remotes — the default base is only as fresh as the local `origin/main`.
- Merge conflicts between agents remain a merge-time concern; isolation removes concurrent-edit corruption, not semantic conflicts.
