# Agent Note: Agent mode as a workspace-grouped live session board
[中文](2026-09-08-agent-mode-session-board.zh.md) | English


Status: implemented

## Problem

Agent mode rendered `AgentGrid` as one-line cards — session title plus an
"updated" wall-clock time. No grouping, no running/idle status, no subagents,
no progress signal: nothing distinguished a busy session from a dead one, and
the registry's subagent lineage (parent ids, origins) was discarded by the
flat list. The board also under-used the frame: sparse cards in a space that
should tile.

## Decision

- `AgentGrid` moves to its own module (`src/client/AgentGrid.tsx`) with a
  pure board builder, `buildAgentBoard`: every workspace becomes a section
  (registry order), each registered session becomes a pane, and subagent
  sessions attach as chip rows under their nearest *rendered* ancestor —
  walking up the parent chain until it reaches a pane. Subagents the
  workspace registry never listed still attach; a subagent whose chain
  leaves every known workspace surfaces in a trailing `Unattached` section
  so a running pane is never invisible.
- The board tiles the full tree area: a `auto-fit` grid of full-height
  panes with 1px separators, replacing the sparse card list.
- Each pane carries a status resolved from summary facts with fixed
  precedence — `pending` (a blocking wait) > `running` (the session or any
  chip) > `done` (finished while away) > `idle` — a pulsing/persistent
  status dot, the agent preset, and, while running, an elapsed clock that
  ticks once per second (a single board-level interval, armed only when
  something runs).
- One level of chips per pane: the board renders panes only, so "nearest
  rendered ancestor" is the attachment rule, not the raw parent id.

## Alternatives considered

**Deeply nested subagent trees.** Rejected for the board: panes tile a
finite area and depth is unbounded; a flat chip row under the owning session
keeps every descendant visible without layout collapse. A deeper tree belongs
to a focused pane's detail view (Phase 2), not the overview.

**Real pty per session (tmux-style processes).** Rejected: agents run inside
the harness already; panes are views over retained summaries and event
streams, not processes. A pty mode stays a separate future decision.

## Consequences

- Pane bodies are status-plus-chips, not live transcripts; the streaming
  tail per pane is a follow-up phase and needs per-session event subscription
  through the object layer, not the summary mirror.
- The builder reads the whole session list every workspace change; session
  counts are small, but a deployment with hundreds of sessions would need
  memoized per-workspace indexes.

## Phase 2 addendum (control semantics)

- `ISessions.interruptSession(id)` exposes the raw `sessions.cancel` wire
  call by id, without selecting the session; the board pane's Stop control
  uses it (nested in the pane, `stopPropagation` keeps the open-on-click).
- Zoom is render-level: a zoomed board renders only the focused pane (full
  grid span); the pane's zoom toggle and Esc leave zoom (tmux `z` semantics).
- Board viewing preferences — pane order (`recent` / `status`) and minimum
  pane width — live in the owning workspace's `dsh.layout.wm:<ws>` stash
  (`agentBoard` key), so each workspace keeps its own board arrangement;
  the preference bar writes them through `onPrefsChange`.
- Pane click remains the attach action: it opens the session as current.
