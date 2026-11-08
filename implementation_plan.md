# Harness implementation status

## Completed work

- Main and subagent model selection follows the configured provider/model routes, with bounded same-turn availability failover and credential-aware eligibility.
- Agent Mail projects settled correspondence, supports an authorized Workspace → Session recipient picker and exact-address Reply, and observes queues without waking or acknowledging recipients.
- Native V4 restoration accepts writer-legal imported conversation preceding its first system prompt while retaining actual-head protection. Existing Session data requires no rewrite.
- Claude API-key inference is a separate `anthropic` route beside unchanged `claude-code` console/subscription login. The named API key cannot silently fall back to OAuth.
- Local operator bundles retain the explicitly authorized gate-scope correction and legacy provider-route cleanup, with guarded configuration edits.
- Documentation generation and dependency metadata are maintained with their source owners. Base configuration has one addressable safety-policy entry.

## Theme and cleanup

Selectable OpenCode-web-inspired `opencode` and `opencode-dark` palettes use the existing theme registry and preserve current defaults and explicit choices. The upstream MIT notice ships with the package. Token readability, selection lifecycle and the assembled browser are checked at desktop and mobile widths. Narrow Settings panes wrap navigation above their controls; coarse-pointer font filters retain a 16px readability floor. Explicitly expanded panes remain mounted and focused across viewport changes, and restoring the layout resumes normal sidebar behaviour.

Intentional outstanding source, tests, documentation, local operator bundles and workspace dependency metadata are committed in coherent groups. Obsolete plans, generated caches and scratch copies are preserved with SHA-256 checksums in a private archive outside the repository; no tracked source or dependency input is removed. Final acceptance includes a fresh artifact build followed by both aggregate checks, focused WM/browser regressions, documentation gates and a clean working tree.

## Operational constraints

Do not restart, reinstall or recompose the running app as part of theme/source cleanup. Installation on disk and activation in an existing process are distinct operations. Keep credentials out of chat, logs and committed fixtures; use existing credential settings. Do not change the neighboring OpenCode fork.
