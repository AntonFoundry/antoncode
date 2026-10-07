# workspace/ — workspace entity family

English

This family owns persistent workspaces: user directories with titles and ordered session membership, plus git worktree isolation over those directories.

| Package | Role | ctx key |
|---|---|---|
| [`workspace/`](workspace/README.md) | Registers workspaces and accounts for their sessions | `ctx.workspaceRegistry` |
| [`worktree/`](worktree/README.md) | Git worktree lifecycle, repo status, and the per-repo default workspace-mode preference | `ctx.worktreeRegistry` |

The [workspace package reference](workspace/README.md) owns lifecycle, persistence, and deletion semantics.

The subsystem reference — the entity, realpath canon, registration/resolution — is [docs/subsystems/workspace.md](../../docs/subsystems/workspace.md); storage design in the [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md).
