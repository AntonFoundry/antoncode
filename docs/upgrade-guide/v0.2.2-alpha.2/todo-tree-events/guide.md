---
kind: upgrade-guide
description: "Todo event consumers must accept the required standing-tree event instead of expecting every update as todo/write."
---

# Standing todo events

## Change

The `todo_write` tool emits `todo/tree-write` for standing task trees, including flat lists. These trees retain cancellation, priorities, and nested tasks across turns. Historical `todo/write` remains a flat three-status list and clears at the next `turn/start`; reading it does not create a standing prompt.

The Session format version is unchanged. Older readers that do not recognize the required tree event refuse these Sessions before adoption. They cannot safely reconstruct a tree by ignoring children or treating cancellation as an unfinished task.

## Migration

1. Update custom Session consumers in TypeScript, Python, and integrations to recognize `todo/tree-write` alongside `todo/write`. Read its `data.todos` tree recursively; retain `cancelled`, optional `priority`, and optional `children`.
2. Preserve the different lifetimes: keep tree writes until the next write replaces them; clear legacy flat writes on `turn/start`.
3. Upgrade readers before opening newly written Sessions. Keep existing Session generations unchanged; no conversion or rewrite of released logs is required.
4. Confirm that an old flat log still clears on a new turn and that a new tree retains its nested tasks after reopening and starting another turn. The [todo package](../../../../packages/todo/tool-todo/README.md) describes the current behavior.
