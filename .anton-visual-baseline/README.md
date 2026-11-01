# Anton visual baseline

The acceptance reference for the upstream reconvergence described in `implementation_plan.md`.
Captured on the `0.1.0-rc.7`-derived tree at tag `anton-pre-merge`, before any upstream code landed.

**The UI's look and feel must not change.** These artifacts are how that is proven rather than assumed.

## Screenshots (`shots/`)

Captured from the live Web GUI served by the installed app at `http://127.0.0.1:3080/`.
They record runtime appearance, which cannot be reconstructed from git, so they are committed.

| file | viewport | covers |
| --- | --- | --- |
| `01-main.png` | 1600x1000 | window-manager board, workspace pane, Todo Tree, Agents/Chat tabs, composer, branding |
| `02-narrow.png` | 1280x800 | the same shell at a narrow viewport |
| `03-wide.png` | 1920x1200 | the same shell at a wide viewport |

Recapture with the identical command so a later image is comparable:

```sh
PROF=$(mktemp -d)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=old --disable-gpu --hide-scrollbars --user-data-dir="$PROF" \
  --window-size=1600,1000 --screenshot=".anton-visual-baseline/shots/01-main.png" \
  "http://127.0.0.1:3080/"
```

`--headless=new` hangs on this SPA and writes no file; `--headless=old` is required.

### Coverage limit

A headless browser opens with no workspace selected, so these cover the shell, theme, typography,
and layout only. Conversation rendering, tool cards, settings panes, and the additive faces
(terminal, worktree, orchestrator, webcam, flowbuilder, agent-mail, file viewers) are **not**
covered and must be verified against the running app by hand before the port is accepted.

## Source of the visual identity

Our look and feel is only partly isolated in Anton-owned packages. It also lives as in-place
edits to upstream client packages, which is why a merge could change it silently:

| package | our added files | our modified source files |
| --- | --- | --- |
| `ui-primitives` | 46 | 22 |
| `ui-layout` | 33 | 10 |
| `ui-theme` | 10 | 12 |
| `ui-conversation` | 6 | 33 |
| `ui-tool` | 0 | 19 |
| `ui-workspace` | 0 | 12 |
| `runtime` | 0 | 12 |
| `ui-settings-general` | 0 | 10 |
| `ui-sidebar` | 0 | 8 |

The token and stylesheet sources that carry the visible identity:

- `packages/client/ui-theme/src/styles/theme-macos.css`
- `packages/client/ui-theme/src/styles/design-platform.css`
- `packages/client/ui-theme/src/styles/gradient-shadow-text.css`
- `packages/client/ui-theme/src/styles/base.css`
- `packages/client/ui-theme/src/system-fonts.ts`, `src/theme-settings.ts`, `src/boot-theme.ts`

## Regenerating the patch set

`patches/` is deliberately **not committed**: every patch is reproducible from git, so storing
1.7 MB of redundant diffs would duplicate history. Regenerate when porting the visual layer:

```sh
MB=$(git merge-base anton-pre-merge upstream/master)   # 99f6f02fec, the 0.1.0-rc.7 fork point
mkdir -p .anton-visual-baseline/patches
for P in ui-theme ui-primitives ui-conversation ui-tool ui-layout \
         ui-sidebar ui-workspace ui-settings-general runtime; do
  git diff "$MB"..anton-pre-merge -- "packages/client/$P" \
    > ".anton-visual-baseline/patches/$P.patch"
done
```

Recovering the full pre-merge tree at any point: `git checkout anton-pre-merge`.
