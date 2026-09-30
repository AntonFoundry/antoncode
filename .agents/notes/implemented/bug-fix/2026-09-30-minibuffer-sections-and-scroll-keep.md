# Agent Note: minibuffer section grouping and active-row scroll-keep

Status: implemented

## Problem

Every minibuffer filter prompt (`C-x b`, `C-x w`, `M-x`, `load-theme`, layout save/restore) renders a height-capped scrolling candidate list, but motion (`↑`/`↓`, `C-p`/`C-n`) only moved the selection — past the fold the highlight left the visible area and navigation went blind. The work had been pinned test-first in commit `c0dd8ff669` (minibuffer spec: workspace sections, header-skipping motion, active-row scroll), but the implementation never landed, leaving that spec red; meanwhile `wm.client.spec.tsx` still asserted the obsolete inline `Workspace · Session` candidate label the sections design replaced.

## Decision

`Minibuffer` owns the fix once for every prompt:

- Candidates carrying `section` render grouped: a non-row header div opens each consecutive run sharing a section. Motion, execution, and preview operate purely on the filtered candidate list, so headers never take a step and cannot execute; filter text matches section titles too.
- The active row scroll-keeps into the list (`scrollIntoView({ block: 'nearest' })` through a row ref, keyed on filter + selection): one row at a time past the fold, no scroll while visible, on mount and on filter changes. This is the behavior `IdoFind` already owned; the shared component now owns it for every picker.
- Cancel (`C-g`/Escape) fires the preview callback with `null` before `onCancel`, so `load-theme` restores the pre-prompt theme even when cancel does not unmount the prompt (the unmount cleanup still fires; `previewTheme(null)` is idempotent).
- `wm.client.spec.tsx`'s stale assertion now pins the sectioned contract (workspace header + session row) instead of the inline `·` label.

## Alternatives considered

Fixing scroll per prompt in `WmFrame` was rejected: the list component is shared, and per-prompt fixes would re-implement the same effect seven times. Manual `scrollTop` arithmetic was rejected: `offsetTop` depends on the nearest positioned ancestor, while `scrollIntoView('nearest')` is the existing ido precedent and a no-op in jsdom. Keeping the inline `·` label was rejected: it contradicts the committed sections spec, which renders the workspace as a group header rather than per-row text.

## Consequences

Navigation past the fold stays visible in every picker, and `M-x`/`load-theme` lists scroll one row per motion step. The minibuffer spec (`minibuffer.client.spec.tsx`) is green against the implementation for the first time since its test-first commit. The spec's scroll test stubs `Element.prototype.scrollIntoView` because jsdom does not implement it; suites rendering the frame (`wm.client.spec.tsx`) carry the same stub.
