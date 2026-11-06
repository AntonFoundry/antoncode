# Anton Orchestrator v2 — [ Orchestrator | Dag Flow | Chat ]

Principle: the UI is a pure function of the harness surface payload. No new state layer.
- engine_health -> health strip | sessions/work_items -> cards
- error events (grouped by signature) -> deduped chips | goal -> mission title
- zone_telemetry -> triage counters

## Global chrome (all tabs)
- HealthStrip: pill per engine_health key. up=green, degraded=amber, down=red. Click -> popover of last N deduped error events. Degraded retrieval shows soft->hard budget countdown (8000ms).
- TriageCounters: "Needs you n . Running n . Failed n" always visible.

## Tab: Orchestrator
Columns: NEEDS YOU (blocked/failed/verifying/stalemate) . RUNNING . DONE. Mission = chief-of-staff root (never edits code). Sub-agent runs nested as rows, role badges: planner | coder | reviewer | test-runner. State machine: QUEUED -> RUNNING -> BLOCKED -> VERIFYING -> DONE | FAILED | STALEMATE
- QUEUED: collapsed row
- RUNNING: compact row (sparkline, token burn, elapsed)
- BLOCKED: expanded card; reason chip (awaiting-approval | tool-500 x3); actions Approve / Retry / Kill / Inject note
- VERIFYING: anti-rubber-stamp gate - summary must anchor to artifacts (diff hash, test output) or stays amber "unanchored"
- FAILED: scoped sub-agent Retry + budget n/3; never restarts mission
- STALEMATE: reviewer<->coder loop (N rounds, no diff delta) -> "escalate: human breaks tie"
- DONE: hidden (activeOnly) — sessions that served their purpose and cannot be revived never render; pass {activeOnly:false} for history.

Transcripts behind "View trace" -> Dag Flow tab, node focused.

Mission modes: Interactive (user-steered) | Autopilot (headless chief-of-staff).

## Run data contract (single source of truth for board + DAG)
{ id, parent_id, role, title, state, model_tier: reasoning|code|deterministic, tokens{in,out}, cost_usd, wall_ms, handoff{ instruction, context_packed[], context_budget_used }, result{ summary, anchors[] }, errors[{sig,count,first_seen,last_seen}], children[] }

## Tab: Dag Flow
- Definition layer: DAG auto-generated from planner breakdown; role-colored nodes; edges = handoffs. Never hand-drawn.
- Execution overlay: node fill = state; badge = active/retry counts; animated edge while delegation in flight. Node click -> side panel (handoff envelope, summary + anchors, retry, jump to transcript).
- Trace waterfall: sub-agent span Gantt; time scrubber replays finished missions.

## Tab: Chat
Unchanged. Add /delegate <task> -> spawns Autopilot mission, deep-links Dag Flow.

## Chief-of-Staff mapping
context isolation -> handoff envelope + collapsed traces; retry boundary -> scoped retry + budget; model tiering -> badges + cost column; telephone game -> envelope visibility + context_budget_used; hallucinated progress -> anchors gate VERIFYING->DONE; stalemate loops -> loop detector -> escalate; sweet spot -> Autopilot lane headless; interactive single-session stays the daily driver.
