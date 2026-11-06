# Agent Note: Subagent Implementation Plans and Split-Buffer Presentation

Status: implemented

English

## Problem

DeepSeek Harness previously maintained structured progress tracking via `todo_write`, but lacked a first-class workflow for large tasks requiring codebase exploration and an implementation plan before mutating code. When tackling complex or multi-phase tasks (≥ 3 tasks or nested to-dos), agents frequently jumped into modifying source code without grounded architecture plans, or dumped massive markdown plans into the main chat stream, consuming context window and cluttering the conversational history. Furthermore, in the desktop app (Anton) and web client, users lacked a convenient way to inspect the implementation plan in an adjacent editor split alongside the chat.

## Decision

We introduce a complete capability loop for subagent implementation planning, disk persistence, split-buffer UI opening, and gate enforcement across four coordinated surfaces:

### 1. Dedicated `plan_write` Tool and Event-Sourced Storage

`@deepseek-ai/dsh-plan-mode` provides a first-class `plan_write` tool alongside `exit_plan_mode`:
- Takes `{ plan: string, title?: string, path?: string }` (defaulting `path` to `implementation_plan.md`).
- Enforces that `plan` contains non-empty markdown beginning with a top-level `#` title heading.
- Persists the markdown file directly to the workspace filesystem at `path`.
- Appends a durable `plan/write` event to the `SessionEventMap` carrying `{ plan, title, path }`.
- Projects `standingPlan: { plan, title, path } | null` into `PlanProjection` so cold re-folds, UIs, and resume retain the active implementation plan.
- Emits a `plan:standing-plan` system prompt section at order 52 (immediately following `todo:standing-plan` at order 51), keeping the model continuously grounded in the approved implementation plan across subsequent turns without polluting conversational turns.

### 2. Side-by-Side Right-Hand Split Buffer Presentation

In Anton (macOS app) and the Web UI layout (`packages/client/ui-layout`), inline-family file paths open through `ILayout.openFile(path)`, which creates a horizontal row split displaying the file in a buffer beside the chat; the chat view's `openFile` face routes inline-first and only OS-open binary families fall through to the Host ([mechanism](../architecture/2026-09-30-plan-block-inline-split.md)). Both `plan_write` and `exit_plan_mode` return presentation metadata with `locations: [{ path }]`, and the dedicated `planToolview` rows render the plan title, a one-line summary, and the saved markdown path as the clickable link that opens `implementation_plan.md` in the right-hand buffer split without cluttering the chat with raw markdown bodies.

### 3. Subagent Delegation Discipline in Prompts and Presets

- `TODO_TREE_DISCIPLINE` in `@deepseek-ai/dsh-tools`: Instructs the model that when tasks are non-trivial (≥ 3 to-dos, multi-phase, cross-package), it must record the plan with `plan_write` BEFORE writing the todo tree — delegating codebase reconnaissance to a subagent (`subagent`) while delegation works, and authoring the plan inline from current knowledge when it fails ([plan-before-tree amendment](../bug-fix/2026-09-30-todo-plan-gate-plan-before-tree.md)).
- `tool-subagent` prompt section: Instructs the model on delegating architectural exploration and implementation planning to subagents for large tasks.
- Agent presets (`standard`, `code`, `cordis`, and base patch): Updated `plan-mode` instructions to delegate exploration to subagents and record plans cleanly via `exit_plan_mode` and `implementation_plan.md`.

### 4. Gate Policy Enforcement (`@deepseek-ai/dsh-gate-policy`)

The `todoPlanGate` in `gate-policy` is extended with:
- `requireImplementationPlan: boolean` (default `true`)
- `minTodosForImplementationPlan: number` (default `3`)
- When total todos (root items plus nested children) reach `minTodosForImplementationPlan`, mutation tools (`bash`, `edit`, `write`, `multiedit`) are blocked with an explicit teaching denial until a `plan/write` event exists in the session log.
- `todo_write`, `plan_write`, and `subagent` are never gated, allowing the model to freely spawn subagents and record the plan to satisfy the gate.

## Alternatives considered

- **Inlining plans into chat assistant messages**: Rejected because raw plan dumps consume excessive context window tokens and clutter human chat history. File-based persistence with split-buffer viewing keeps chat lightweight and readable.
- **Requiring plan mode for all plans**: Rejected because users often prompt the agent to implement a large task directly in default mode. `plan_write` allows direct or subagent-driven plan creation without forcing a manual `/plan` modal toggle.
- **Counting only root tasks for gate policy**: Rejected because multi-phase projects are frequently structured as 1 root phase with multiple nested child subtasks. Recursive counting accurately reflects project scale.

## Consequences

Large project workflows follow a disciplined plan-first pattern ([plan-before-tree amendment](../bug-fix/2026-09-30-todo-plan-gate-plan-before-tree.md)):
1. Model forms the plan and records it via `plan_write` (or `exit_plan_mode`) BEFORE any `todo_write` for non-trivial work; delegation to a `subagent` drafts the plan while delegation works, and inline authoring replaces a failed delegation.
2. Model creates the todo tree via `todo_write`, so a tree at or above the gate threshold always has its implementation plan already recorded.
3. Mutation tools therefore stay unblocked; the user clicks the plan link to inspect the formatted plan in the right-hand editor buffer split.
4. The agent executes tasks guided by both the standing todo tree and the standing implementation plan.
