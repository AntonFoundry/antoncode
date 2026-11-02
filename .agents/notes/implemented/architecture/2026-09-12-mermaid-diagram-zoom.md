# Mermaid diagram zoom controls

Date: 2026-09-12

## Context

Settled ```mermaid fences render as static SVG with a copy-image control, but
large diagrams (the c0ntext architecture graph being the motivating case)
shrink to unreadable text at fit-width. The user asked for zoom.

## Decision

Zoom stays inside `MermaidDiagram` (ui-primitives), the component that already
owns diagram presentation — no new slot, plugin, or package. One wrapper width
percentage (50%–300% in 50% steps) drives everything:

- `−` / `+` buttons and Ctrl/Cmd+wheel step the scale; the percent button resets.
- The zoomed wrapper width plus the card's own `overflow-x` provides panning,
  so no pan-state machine exists: at 100% the code path is exactly the old one.
- Zoom is component-local state — it intentionally resets on re-render/theme
  switch and never reaches the session log (pure presentation, nothing
  model-visible).

Labels ride the existing `MermaidLabels` pipe (locales → AssistantMarkdown →
render context) with English fallbacks at the render boundary, matching the
copy-image precedent.

## Consequences

- No new extension points; the card's control row groups zoom + copy.
- Tests: `mermaid.client.spec.tsx` covers steps, bounds, reset, and the
  wheel gating (plain wheel must not zoom).
