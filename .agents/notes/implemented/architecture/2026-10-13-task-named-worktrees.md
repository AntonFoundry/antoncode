# Agent Note: task-named worktrees via the session title

Status: implemented

## Problem

Auto-created worktrees carry timestamp names (`wt-20261012-202343`), so the
composer's workspace selector, the sidebar prefix, and the workspace browser
show a name that says nothing about the work inside. The user's flow makes
the real name available seconds later: the first send is exactly when the
content is known, and the session-title pipeline already derives a title
from that first message.

## Decision

Reuse the session-title output rather than adding a second generation
request. The host subscribes to `session/title` and hands the title to
`WorktreeRegistry.aliasFromTitle(sessionId, cwd, title)`: the worktree
record gains a durable `alias` (plus `aliasSessionId`) — the title's slug
under the existing `slugify` rules (lowercase, `[a-z0-9-]`, ≤40 chars,
`wt` fallback claims nothing). Consumers derive display names through it:
`namesByWorkspaceId` in the client runtime (sidebar `<worktree>/<title>`
prefix), the composer selector's trigger, "This session" heading, and
per-worktree reuse rows.

Claim semantics: the FIRST titled session inside a worktree claims the
alias; later titles from that same session refine it (fallback title
immediately, provider title when it lands, user rename), and other
sessions never rename it — a reused worktree keeps its first claimant's
name, so shared-worktree sessions cannot flap the name.

The alias is display-only by design: the session header's cwd is
immutable (`SessionCwdConflict`), log-file paths derive from it, and
`git worktree move` under a live session would strand both. Renaming the
directory on disk is a cwd-migration feature, deliberately not attempted
here.

## Alternatives considered

- **Defer worktree creation to the first send** — breaks isolation before
  the first turn or requires creating the session against the checkout and
  re-homing it later, which the cwd immutability forbids.
- **A second LLM request for a worktree name** — duplicates cost and
  latency; the title already is the task name the user asked to reuse.
- **Rename on disk when idle** — same cwd-migration wall, plus tools and
  shells holding the old path.

## Consequences

Worktrees follow the session's naming machinery instead of a clock. A
worktree whose sessions never produce a usable slug (or whose first
session never sends) keeps its timestamp name. The alias propagates to
clients on the next `worktree.list` pull (mount, mutation, selector
open) — there is no push channel for alias changes yet.

## Testing

Registry tests cover claim, refine, foreign-session refusal, slug rules
(including the `wt` fallback claiming nothing), and no-op repeats; the
composer selector spec covers alias-first display naming; the client
runtime suite covers `namesByWorkspaceId` alias preference.
