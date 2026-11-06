# Agent Note: Orchestrator board: real RPC wiring + mission-plan folding

Status: implemented

## Problem

The board needs Workspace and visible Session state without per-Session history reads. Mission cards need the existing todo projection without an additional wire request.

## Decision

The Orchestrator v2 board is live: `orchestrator.board` (host, `packages/host/apiproxy/src/api/orchestrator.ts`) composes `workspaceRegistry.list()` + the visible `session.list` summaries in one round trip, and `orchestrator.act({sessionId, action:'kill'})` cancels a session through the same shared `cancelSessionRequest` helper as `sessions.cancel`. The client plugin `ui-orchestrator` (packages/client/ui-orchestrator) registers two `conversation.view` entries (`orchestrator` order 5, `dagflow` order 6) via `ctx.slots.inject`, pulls the board on inject and every 15s, and folds the snapshots into run cards through the pure `deriveRuns` bridge.

Mission cards now carry the session's **plan**: the board wire already includes every registered session projection (`SessionSummary.projections.values`), so the client reads the `todos` projection (the latest `todo/write` snapshot, folded by tool-todo's `sessionProjections` unit) — no host change, no extra RPC. `flattenPlan` (contract.ts) depth-flattens the three-level tree into `Run.plan`, and `runCard` renders a collapsible `Plan <done>/<total>` section. Titles come from the runtime sessions service's `displayTitle` overlay, not bare session ids.

## Alternatives considered

- **Board data path**: one `orchestrator.board` RPC beats N per-session history reads; the host's projection cache (watermark + persisted checkpoints) makes a 15s poll O(cached reads).
- **Plan rendering stays vanilla DOM**: `runCard` is imperative; `TodoTreeBody` is a React component with locale seats, so the card replicates ~15 lines of row rendering instead of crossing stacks. Revisit only if mission cards move to React.
- **Fixture parity**: `FixtureApiClient` dispatches every new RpcMethodMap key — the fixture's `orchestrator` domain composes its own fixture rows so client tests need no host.

## Consequences

- The bridge cheap-model fallback depends on the coding-plan endpoint for coding-plan-only keys; the plain endpoint can reject those credentials.
- Unknown-model failures after boot are contained by [serving-lifetime rejection handling](../bug-fix/2026-09-27-fail-loud-retired-after-boot.md). A configured model pin supplies availability before live discovery finishes.
