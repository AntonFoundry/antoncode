# Agent Note: Composer workspace selector merge

Status: implemented

## Problem

The composer tool row showed two adjacent branch-icon chips that read as two redundant worktree pickers: a read-only location chip (worktree name, or the branch in the main checkout) and the workspace-mode select labeled with the *preference* ("New worktree"). The first is a fact about the open session; the second is the per-repository default applied to the NEXT new session. Only a tooltip revealed that picking "New worktree" never changes the open session, so the pair invited the wrong mental model.

## Decision

One workspace selector: the location chip becomes the menu trigger, and the mode rows move into its menu under two headings — "This session: …" (the location fact) and "Default for new sessions in …" (the rows' meaning) — so the fact/preference split is carried by visible structure instead of a tooltip. Opening the selector keeps the old chip's requery edge. The base-ref picker (`From <base>`) stays a separate chip: it is a different axis (base ref, not workspace) and only matters when a worktree mode applies. The non-repository posture folds into the same pattern (locked title as the trigger title, reason heading over greyed rows). `WorktreeModeSelect` is absorbed into `ComposerContextBar`; the pure helpers move to `helpers.ts`; the retired locale keys (`mode.aria`, `hint.mode`, `hint.new`) are replaced by the visible headings plus `bar.current`.

## Alternatives considered

- **Fold the base picker in as a footer row** — one chip total, but it needs nested-menu support in the shared `Menu` primitive for a different-axis choice; deferred.
- **Retitle the two chips instead of merging** — keeps the temporal split visible without a tooltip but leaves the two-chip redundancy the confusion came from.

## Consequences

The next-session default is no longer visible without opening the menu; the trigger now spends its label on the session's actual location. Pages that captured the old mode chip in replay goldens needed a refresh, and the non-repository fixtures show the locked trigger title.

## Testing

`composer-context-bar.client.spec.tsx` covers the merged trigger (location label, worktree naming, locked posture), the mode menu (headings, effective default, mode writes, reuse rows), the base picker (fallbacks, merged writes), and the requery edges; the web replay goldens are refreshed for the assembled composer row.
