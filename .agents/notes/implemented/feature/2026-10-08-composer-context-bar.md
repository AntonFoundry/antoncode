# Composer context bar: worktree menu, repo indicator, base picker

Date: 2026-10-08 · Status: implemented

## Problem

The reference design places three workspace controls in one slim bar under the composer: the repository indicator, the workspace-mode menu, and a base-ref picker (`From origin/main`). The shipped UI had the mode menu alone in the composer toolbar row (`conversation.input.left`), no composer-area repo indicator, and no base selection at all — every new worktree silently branched from the host's origin/main→HEAD fallback, with no way to choose.

## Decision

- **Seat**: the bar is a `conversation.input.dock` entry (order 30, after the queue strip at 20) owned by `ui-worktree` and injected into ui-conversation's slot — the InputBar footer is the reference's position. The old `conversation.input.left` seat is removed.
- **Composition**: `ComposerContextBar` renders the branch chip (re-queries `worktree.status` on click, mount, and the running→idle edge), embeds the existing `WorktreeModeSelect`, and adds the base picker on the right.
- **Base semantics**: `worktreeModePref` (domain spec, wire schema, and the hand-written view) gains an optional `base` per member; `worktree.status` gains `bases: string[]` (`git for-each-ref` over `refs/remotes`, capped at 11, plus `HEAD` — remote-tracking only, so a huge monorepo cannot flood the picker). The runtime's New Session flow passes `pref.base` to `worktree.create`; the host's `resolveBase` already verified explicit refs, failing loud on unknown ones. Absent a stored base the effective default stays origin/main, then the first candidate, then HEAD — displayed, not persisted, until the user chooses.
- **First-time repositories**: `WorktreeModeSelect` previously rendered nothing until a preference existed, so a fresh repo offered no control. It now falls back to `{ key: cwd, pref: undefined }` — the effective default (checkout) shows selected, and the first choice writes the first preference. This mirrors the runtime, which treats a missing pref as checkout.
- **Mode select survives, relocated**: same component, now embedded in the bar instead of the toolbar row.

Alternatives considered:

- *A shared status cache/hook*: rejected — the client slot standard forbids module-level caches and business-made hooks; status stays per-component via the inject callback (the chip's established pattern), with the duplicate reads recorded as a known limitation whose real fix is an object-layer projection in the runtime.
- *Host-side mode resolution in `session.create`*: kept the existing client-side orchestration (`startSession` → `worktree.create` → `session.create`), so the host session contract stays `workspaceId | cwd`.

## Consequences

- The composer area matches the reference: chip + mode menu + base picker in one bar under the composer; the stash chip remains in the session header.
- Base selection is durable per repository (stored with the mode pref in the worktree registry domain).
- Composer-area aria snapshots in `apps/web` e2e change; the refresh was blocked by machine saturation (unrelated `BTLEServer`/OrbStack CPU spin stalled animation-sensitive scenarios) and lands in a quieter window alongside the pre-existing `queue-actions` local failure.

## Verification

- `packages/workspace/worktree` tests: `listBases` with/without remotes, status carries bases, pref round-trips a base (22 tests).
- `packages/client/runtime`: `startSession` passes `pref.base`; unchanged flow without one.
- `packages/client/ui-worktree`: the bar's render arms, base merge, rejection tolerance, HEAD/first-candidate fallbacks, and the dock registration (24 tests); full `test:gui` (4238) green.
