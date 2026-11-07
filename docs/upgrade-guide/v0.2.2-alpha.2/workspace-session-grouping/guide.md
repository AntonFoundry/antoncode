---
kind: upgrade-guide
description: "Workspace grouping writes use domain version 3, which older binaries cannot reopen."
---

# Workspace grouping uses domain version 3

## Change

Workspace navigation can assign an existing Session to a different Workspace or synthetic Ungrouped without changing its recorded cwd, execution roots, or history. Explicit assignments are stored in the `workspace` domain's global `sessionAssignments` field, separately from directory-derived accounts.

The Workspace domain accepts version 2 data and defaults missing assignments to an empty list. Reading existing data does not rewrite it. The next Workspace domain write stamps version 3; older binaries refuse that version instead of dropping grouping assignments. This is a Workspace domain change, not a Session log format change.

## Migration

1. Upgrade every application that writes the same Harness home before changing Workspace navigation. No manual edit to `cordis.yml`, Session logs, or Workspace records is needed.
2. Open the existing Workspace list and confirm its titles and Session grouping remain intact. Move a Session to another Workspace or Ungrouped, then reopen the application and confirm the assignment remains.
3. Keep the upgraded binary when using that data. Downgrading a version 3 Workspace domain is unsupported; do not lower its version stamp or remove `sessionAssignments` to bypass refusal.
