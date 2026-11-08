---
kind: upgrade-guide
description: "The native V4 reader now accepts seeded Session history that begins with imported conversation and appends its first system message later."
---

# Seeded Sessions can resume with a later system message

## Change

A seeded Session can begin with imported user and assistant messages before the Harness appends its first `system/message`. The core surface and system-prompt projection preserve that imported prefix. The native V4 reader previously rejected this legal history with `SessionFormatError: system/message requires a protected first surface head` when reopening it.

The fixed reader accepts the stored history without moving, inserting, or removing events. Head protection follows the current first surface node: when that node is a `system/message`, replacements must preserve its protected position; system nodes later in the conversation are not protected heads. This also applies when a valid replacement makes a system message the current head.

This is a native V4 reader correction, not a provider-specific repair or a Session-format migration. The Session version, declared event types, and released V3 codec remain unchanged. An older build can still refuse the same legal V4 history; that refusal does not by itself establish physical log corruption or an adapter fault.

## Migration

1. Install a build containing the corrected native V4 reader at the agreed maintenance point. Running applications retain their installed reader until activation; development changes alone do not update them. Coordinate application activation or restart with active work.
2. Reopen the affected Session unchanged. Do not edit its JSONL, truncate history, insert an empty system head, or re-save it through an older writer to work around this error. No Session rewrite or data conversion is required by this fix.
3. Confirm that the Session opens with its imported conversation intact and can continue without the protected-first-head error. Other validation failures still require their own diagnosis; the fix does not bypass malformed event data or protected-head replacement checks. The [reader package reference](../../../../packages/session/session-format-v3-to-v4/README.md) owns native validation details.
