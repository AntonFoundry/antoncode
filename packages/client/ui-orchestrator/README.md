# @deepseek-ai/dsh-client-ui-orchestrator

Orchestrator surface tabs over the per-session view ring: [ Orchestrator | Workflows | Chat ] —
Chat remains the default view. Spec: docs/specs/orchestrator-v2-spec.md

## Wiring

- `apply(ctx)` registers two `conversation.view` entries (ids `orchestrator` order 5,
  `dagflow` order 6) through `ctx.slots.inject`; plugin unload removes both tabs.
- Board data comes from the `orchestrator.board` RPC in one round trip (workspaces with their
  session accounts, the archive set, and the visible `session.list` summaries including the live
  `running` flag). A refresh-on-inject pull plus a 15s interval poll keeps the snapshot fresh; the
  interval is disposed with the plugin fiber.
- `onAct(sessionId, action)` forwards card actions; only `kill` is server-side today
  (`orchestrator.act`), and it refreshes the board after the host accepts. `approve`, `retry`,
  `inject note`, and `focus` are client-side placeholders.

## Model Experience

- Adds no tools, prompt sections, tokens, or session events: the plugin is browser-only and
  pure-consumer, so the model's context and KV cache are untouched.
- For the human, the session header gains two tabs. Orchestrator triages every visible session
  into NEEDS YOU / RUNNING / DONE columns with per-run cards; the Workflows tab (ui-flowbuilder) draws the board as a
  Langflow-style node canvas. Non-running sessions classify by recency (updated within 24h reads
  queued, else done); the attached agent's live `running` flag always wins.

## Workflows

The workflow canvas moved to [`ui-flowbuilder`](../ui-flowbuilder/README.md), which owns the `dagflow` view id (Workflows / 工作流). This package registers only the Orchestrator board tab.

## Known Limitations and Deferred Work

- No title projection: `session.list` carries no display title on the wire yet, so run cards show
  session ids; cards switch to titles when the projection ships.
- Dag Flow is a projection: no drag-to-connect, node creation, or per-workspace group frames yet;
  an open tab repaints on the 15s board poll, not live.
- Card actions other than `kill` have no server-side action and log only.
- The board snapshot is read at inject time; an already-open view refreshes on the next poll
  interval via remount, not live mid-render.
- LLM-backed features (mission titles, `/delegate`) are not part of this package.
