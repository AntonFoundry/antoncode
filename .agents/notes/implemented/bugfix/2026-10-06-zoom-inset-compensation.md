# Agent Note: Zoom-compensated fixed positioning for measured primitives

Status: implemented

English

## Problem

With a font-size zoom active (`--dsh-zoom-ui` / `--dsh-zoom-chat` from the font settings runtime), hovering a message's `…` button drew the "More actions" tooltip bubble far from the button (toward the viewport's bottom-right), and the delete-via-fork `Menu` opened displaced the same way. Both surfaces measure the anchor with `getBoundingClientRect()` and paint `position: fixed` elements from that rect, assuming one coordinate space.

The app zooms the interface through CSS `zoom` (the frame carries `--dsh-zoom-ui`, the chat pane the compensated `--dsh-zoom-chat` ratio). Probed against this Chromium build (Playwright), the actual semantics are: `getBoundingClientRect` returns **true viewport coordinates** even inside zoomed subtrees; a plain fixed element paints exactly at its inset; but a fixed element carrying `zoom` — itself or through ancestors — paints at **inset × every zoomed ancestor's factor**, and `zoom` is not inherited (each zoomed ancestor compounds; descendants compute `1`). So every rect→fixed primitive was drawing at `rect × zoom`: the tooltip bubble (a sibling inside the zoomed chat pane) and the portaled menu list (which deliberately re-carries the interface zoom, `Menu.module.css .portal`) both landed down-right of their anchors, exactly the reported screenshot.

## Decision

`ui-primitives/src/zoom-scale.ts` adds `fixedInsetScale(element)`: the product of computed `zoom` from the element through the document root, skipping non-numeric entries. Primitives divide measured viewport coordinates by the factor acting on the element they position:

- **Tooltip** — stores anchor coordinates in inset space (`pos.scale` captured at show); the viewport-fit pass converts its clamp delta back with the same factor.
- **Menu portal** — placement math runs in true viewport space (including drawn width/height = `offsetWidth × scale` for end/top alignment and edge clamping), then the final insets divide.
- **JsonTree copy anchor** — row coordinates divide; the 26px pull-in stays in local units; the side flip now compares against the root's true rect height instead of the local `clientHeight`, which mixed coordinate spaces.
- **useAnchoredMaxHeight** — the measured clearance divides so the applied `max-height` renders at the intended true height.

Unaffected by design: `HoverCard` and `Toast` portal to body without self-zoom, so their insets are already in true space.

## Alternatives considered

**Stop zooming and switch the interface to `font-size`-only scaling.** `zoom` is what keeps dense chrome proportioned at large text sizes; re-layouting every surface to bare font scaling is a redesign, not a fix.

**Drop the portaled list's self-zoom and render menus at unzoomed size.** Menus would visibly shrink against the zoomed chrome — trading one defect for another.

**Compensate at the measurement source** by scaling rects up before storage. Same arithmetic at every call site; the shared factor helper keeps one probe-verified contract and one place to extend (HoverCard-style portals stay exempt by simply not calling it).
