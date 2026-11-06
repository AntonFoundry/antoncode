# Agent Note: Minibuffer opening-swallow guard (stray M-x character)

Status: implemented

## Problem

Opening `M-x` (Option+X) seeded a small stray character into the freshly opened filter input. The `load-theme` prompt, opened via Enter from the palette, was clean — the character came from the Option+X keystroke itself.

## Decision

The frame's capture-phase `keydown` listener calls `preventDefault()` before dispatching `m-x`, but the browser focuses the minibuffer input during the opening keydown's React commit and then performs that keydown's text-insertion default action into the newly focused element. Not every browser honors `keydown`-`preventDefault` for Alt-combos (macOS Option produces a character; WebKit has historically let some such insertions through), so the produced character landed in the input. A second, engine- independent leak: pressing M-x while a prompt was already open hit the listener's already-open early return, which never called `preventDefault`.

## Consequences

1. `Minibuffer`: an opening-swallow guard — armed at mount, disarmed by a 0ms timer and by the input's own first keydown. The first input event inside the opening keydown's task is the leak, never user typing (no human keystroke shares the opening keydown's task); it is dropped and React's controlled-value restore clears the field.
2. `WmFrame.onKey`: the already-open branch now consumes alt-only letter chords (`preventDefault`) before returning — Option+letter never means text entry in a filter; arrows and bare keys keep native motion.

## Alternatives considered

- `wm.client.spec.tsx`: the leak is simulated as a first input event at mount instant (faked clock unadvanced) and must not seed the filter; a clock advance crosses the window and typing lands. The re-open chord test asserts `preventDefault` fires in the already-open branch.
- Tests that type into a freshly opened prompt go through the `typeInput` helper, which advances the (faked) clock past the window first — the same distinction real typing has. `minibuffer.client.spec.tsx`'s filter test crosses the window with a real 0ms await (that spec uses real timers).

## Coordination note

Committed together with the workspace-section grouping + scroll-keep work in the same files (concurrent session); the batch commit should carry both Agent Notes. `typeInput` in wm.client.spec.tsx and the minibuffer.client filter test encode the swallow-window contract for future prompt work.
