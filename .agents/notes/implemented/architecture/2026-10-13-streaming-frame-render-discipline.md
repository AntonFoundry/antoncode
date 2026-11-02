# Agent Note: streaming-frame render discipline in the composer skeleton

Status: implemented

## Problem

The render audit found the conversation skeleton re-rendering once per
animation frame while tokens stream, and once per keystroke:

1. `ConversationSession` subscribed to the whole `InputState` while its
   render body reads none of it (the draft is only read by the mount-time
   seed effect).
2. The input facade's `publish()` set a freshly composed `InputState` on
   every session notification — one per streaming frame — re-rendering
   every `useInput` subscriber although all composed members are
   identity-stable unless genuinely changed.
3. `ChatView` was unmemoized and received a fresh `onInspectDone` closure
   per parent render, so each of those frames rebuilt the N-row body
   (element creation + shallow compare per node), defeating the per-row
   `ChatNodeSeat` memos.
4. `AssistantMarkdown` built `mermaidLabels`/`imageLabels` inline per
   render, defeating `MarkdownText`'s memo and re-parsing settled blocks
   (full mdast parse) on parent re-renders.
5. `ConversationRoot` ran two workspace-array scans per render body.

## Decision

Narrow the selector to the draft string, guard `publish()` with an
own-key shallow comparison (every `InputState` member is identity-typed
upstream: machine state, `imageIds`, and the queue read face are
reference-stable across unrelated session snapshots), memo `ChatView`
(its un-depensed layout effect is safe — every branch is guarded by refs
that only move when subscribed data moved), stabilize `onInspectDone`
with `useCallback`, memoize the two label objects and the image loader
on the locale seat identity (the discipline `codeLabels` already
documented), and `useMemo` the workspace scans.

## Alternatives considered

- **Narrow ConversationRoot's whole-snapshot selector** — the root
  legitimately passes the live snapshot into the composer-chain and input
  zone props; changing that owner-prop contract is a cross-package
  redesign. With the fixes above its remaining per-frame body render is
  cheap, and the expensive descendants bail on memo.
- **Split the input queue face off the session notifier** — the shallow
  guard achieves the same effect with one line of mechanism.

## Consequences

A change to `InputState`'s shape must keep members identity-stable for
the guard to hold (already the store's own discipline). ChatView now
skips renders whose props are shallow-equal; anything passed to the chat
view slot in future must stay referentially stable per session state.

## Testing

The full ui-conversation suite (446 tests) and the GUI tier pass
unchanged — these are render-discipline changes with no behavioral
surface; the render audit's file:line findings are the review record.
