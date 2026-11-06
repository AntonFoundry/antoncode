# Todo

English | [中文](todo.zh.md)

The durable todo vocabulary owned by [`@deepseek-ai/dsh-tool-todo`](../../packages/todo/tool-todo/README.md). The model-facing tool replaces one agent session's whole list; the package also owns the event declaration and replay projection. Tool behavior and configuration are on the [package README](../../packages/todo/tool-todo/README.md).

Source: [`packages/todo/tool-todo/src/types.ts`](../../packages/todo/tool-todo/src/types.ts)

## `TodoItem` — one list entry

```ts type-equiv
/**
 * One node in an agent's todo tree — the unit of the `todo/tree-write`
 * whole-tree snapshot declared by this package.
 *
 * A node carries a human-readable `content` line, a four-state `status`, an
 * optional `priority`, and optional nested `children` — up to three levels
 * (top-level task, child, grandchild), enforced at the tool-JSON boundary and
 * by the owning package invariant, not by this type. The tree is replaced
 * wholesale on every write (last-write-wins), so nodes need no stable identity.
 */
interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /**
   * Lifecycle state. `in_progress` marks a task being worked now; parallel
   * work may mark several. `cancelled` retires a node no longer needed without
   * counting it unfinished.
   */
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  /** Scheduling weight the model assigns; presentation-only. */
  priority?: 'high' | 'medium' | 'low'
  /** Nested subtasks, at most two levels below a top-level node (three levels total). */
  children?: TodoItem[]
}
```

## Durable event

The package declares log-only `todo/tree-write: { todos: TodoItem[] }` for standing trees and retains `todo/write` for released flat three-status lists. Both replace the whole value; only the legacy event clears on `turn/start`. An older reader that does not recognize the required tree event refuses the Session before adoption. The generated [persistence catalog](../persistence-catalog.md) records both declarations.
