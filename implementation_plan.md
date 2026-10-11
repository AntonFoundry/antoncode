# Drive the remaining local-main failures to green

## Goal
The fork's local `main` (131 unpushed commits, including a WIP checkpoint) carries ~57 failing tests across ~33 host suites plus three client-side behavior regressions. Fix or refresh each cluster to green, one root cause per commit, and leave the three standing gates (`test:gui`, `test:coverage`, targeted `test:web` replay) green. Machine load (OrbStack) stays out of scope: load-sensitive verdicts are taken from solo runs.

## Phases
1. **Survey & classify** — DONE.
2. **Fix host clusters** — DONE (14+ conventional commits per root cause).
3. **Fix client regressions** — DONE (test:gui 4247 green; no reproducible JSDOM-lane regressions).
4. **Gates** — `test:gui` green, `test:coverage` deterministic content green, docs gates green (AGENTS budgets pre-existing red, reported).
5. **Web replay reconciliation** — the replay lane was pre-existing red (103 failures / 51 files) behind four intentional WIP surface changes: settings window shell (no 关闭, WM Close control), first-run onboarding modal (inert root), WM grid layout (retired `centerCol`), paged tool gating (`tool_search` grants). Five fixture clusters reconciled in parallel (46/51 files green solo). Four verified product bugs delegated to fix agents: theme boot adoption, history presenter-view re-derivation (terminal + write views), WM narrow-drop sidebar race, opensInline directory routing. Two fixes pre-staged in-tree: worktree runGit classification, tool-card toggle localization.
6. **Final** — review all working-tree diffs, commit per concern (fixture clusters + each source fix), ONE rebuild, refresh English-page goldens pinned to the old hardcoded Chinese labels, re-verify the four bug tests (settings-chrome theme, navigation-panes terminal card + sidebar, produced-files Show in folder), then the full `pnpm run test:web` replay verdict and the closing report. permission-policy-context re-record stays BLOCKED (no DEEPSEEK_API_KEY on this machine).