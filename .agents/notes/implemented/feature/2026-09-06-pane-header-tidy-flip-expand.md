# Agent Note: Pane-header tidy/flip/expand and focused-pane accent

Status: implemented

English

## Problem

Pane operations existed only as keychords (C-x 1 / M-x), so the BridgeMind-style tiled layouts had no visible, per-pane controls — and nothing distinguished the focused pane's header from the rest, making multi-pane layouts hard to read.

## Decision

- Every pane's mode line carries three buttons beside Close: **Tidy** (balance every split's weights to equal shares, recursively — `tidyTree`), **Flip** (swap the pane with its sibling in the parent split, weights traveling with the panes — `flipWithSibling`), and **Expand** (keep only this leaf — the C-x 1 semantics, `keepOnlyLeaf`, plus focus). `M-x tidy-panes` and `M-x flip-pane` join the command table.
- The focused pane's mode line carries the theme accent: brand-primary top inset, raised background, and a brand-tinted buffer name. Unfocused panes keep the resting treatment. Token-driven (`--dsw-alias-*`), so every registered theme re-tints it.

## Alternatives considered

**Expand by closing siblings one-by-one.** Rejected: `keepOnlyLeaf` is the existing C-x 1 transform — one operation, no intermediate states.

**Global-only Tidy/Flip in M-x.** Rejected: point-and-click pane management is the point of the tiled code mode; the commands remain for keyboard users.

## Consequences

- Mode lines now host up to six buttons; narrow panes may truncate titles before buttons (buttons win the flex contest).
- Flip on a leaf without a sibling is a no-op returning the same tree.
