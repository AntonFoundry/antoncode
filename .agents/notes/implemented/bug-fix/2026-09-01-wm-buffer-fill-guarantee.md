# Agent Note: WM buffers fill their windows
English | [中文](2026-09-01-wm-buffer-fill-guarantee.zh.md)


Status: implemented

## Problem

The Emacs-style window manager drew windows that their buffers did not fill. A window switched to the Workspace buffer (C-x b after closing the home sidebar window) rendered the workspace browser as a small 288×260 box inside a 1600×449 window, with the rest empty. Two independent causes:

1. `WmFrame`'s pane wrapper pinned ANY leaf showing the `sidebar` buffer to `flex: 0 0 ${width}px`. In a column split the basis applies along the vertical axis, so the pane was pinned 288 px TALL; and in any placement other than the home left column the pinned px bore no relation to the window's actual slot.
2. `SidebarRoot` set its own inline `width` (the owner-provided column px) whenever expanded, so the buffer could not stretch wider than the column preference even when its window was wider.

Even with both fixed, a dead strip remained at the frame's right edge: flex-grow factors below one distribute only that fraction of the free space (the sub-one flex-factors rule), so the chat's stored weight `0.8` beside the grow-0 pinned sidebar filled only 80% of the leftover width. The wrapper grow is therefore renormalized over the split's unpinned weight total, keeping Σgrow at exactly 1; a side effect is that sash drags beside a pinned sidebar now track the pointer 1:1 (they previously moved the boundary by only the grow fraction of the delta).

A third defect compounded the symptom: the c0ntext plugin called `ctx.layout.openDetails()` on every boot (rAF-deferred), re-splitting the chat window against ui-layout's own "Context starts closed" decision and re-fighting every user close on reload. And `onSplit` silently refused to split (`C-x 2` on the chat pane was a no-op whenever a Context window was already on screen), because the conversation split rule focused the existing details leaf instead of splitting.

## Decision

- The px pin is scoped to the one pane it was meant for: the HOME sidebar pane — the canonical sidebar leaf (`WM_LEAF_SIDEBAR`) as a child of a row split (`isHomeSidebar`). Every other window carries split weights (`flex: W 1 0%`) whatever buffer it shows, so the fill chain (treeArea → split → paneWrapper → pane → paneBody → buffer root) holds for every buffer/window pair.
- Sash drags follow the same predicate: only a boundary touching the home sidebar pane writes the width preference; a detached workspace window's boundary rewrites ordinary split weights.
- `SidebarRoot` fills its window: no inline width when expanded (the root stretches; `width: 100%` stated for the guarantee); the inline width survives only as the collapse fade's frozen last expanded width.
- `C-x 2`/`C-x 3` always split, showing the anchor's OWN buffer: a buffer is content, a window is a view onto it, and singletons clone like any other buffer (two Chat windows are two views of the one session surface; the registry keeps exactly one buffer of each kind). This superseded the interim pairing rule (chat → Context, else `*scratch*`), which itself replaced an earlier silent no-op.
- The c0ntext plugin drops its boot-time reveal; the map opens through the header toggle or the `c0ntext:open-map` recovery control.

## Alternatives considered

**Remove the px pin entirely (weights everywhere).** Rejected: the sidebar width preference (store-persisted px, drag-clamped contract) is the shipped geometry contract; the home column must track it, not a weight ratio.

**Keep the pin on `buffer === 'sidebar'` and teach SidebarRoot responsive widths.** Rejected: in a column split the pinned basis orients the wrong axis; no component-level fix repairs a wrong-axis flex basis.

**Auto-open the context map once per workspace instead of per boot.** Rejected: any automatic `openDetails` re-fights the user's close gestures after reload; on-demand open is the recorded layout decision (Context starts closed).

## Consequences

- Buffers fill their windows in every placement; measured end to end in the served app (workspace buffer in a 1600 px window fills 1600 px).
- `C-x 2` on the chat pane clones the chat into a second window; `C-x b` clones instead of yanking focus, and `C-x ←/→` cycles the whole registry without skipping buffers shown elsewhere.
- Boot loads with Workspace | Chat; the context map opens on demand.
- Persisted trees heal on load by weight renormalization only — the duplicate-singleton dedupe and the forced Context close are gone, so an arranged layout (including intentional clones) reloads exactly as arranged.
