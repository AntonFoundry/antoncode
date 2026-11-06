# Agent Note: Three-line composer resting height

Status: implemented

## Problem

The docked composer reserves only one line when its draft is empty, leaving little room to compose before text wraps and the box grows. The composer card is also the primary writing area, so its resting height should provide more space without changing how longer drafts grow or scroll.

## Decision

The hidden mirror sets the draft area's minimum height to 72px, or three 24px lines. The composer card gains that resting space while the mirror continues to size it to longer drafts, and the shared 336px scroll cap still bounds long text. The blank-session hero uses the same three-line minimum.

This setting changes the draft-area floor instead of fixing the whole card height. The control row, attachment rail, and dock entries therefore keep their own measured space.

## Alternatives considered

**Keep a one-line resting draft.** This saves vertical room, but leaves little space for a multiline prompt and makes the card expand as soon as the user starts composing.

**Set a fixed height on the whole card.** This would reserve space for the control row and optional attachments even when they need different amounts of room, and it would interfere with draft-driven growth.

## Consequences

The empty chat composer is taller and exposes three text lines before scrolling; longer drafts still grow naturally and scroll at the existing cap. The same text area minimum applies to the blank-session hero so choosing a workspace does not change the composer size.

The transcript and composer fill the conversation root using the shared width axis documented in the [composer width decision](../../archived/feature/2026-08-04-web-composer-shared-width-axis.md), with existing side gutters retained.
