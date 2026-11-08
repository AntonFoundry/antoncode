# Agent Note: Native V4 reading preserves seeded conversation before a system message

Status: implemented

## Problem

A seeded Session can import a user/assistant conversation without a system node. When the Harness later renders its first system prompt, `SystemPromptProjection` appends it after that history instead of rewriting the imported prefix. The core Session surface accepts this order, but the native V4 relationship reader rejected any system message encountered after a non-system prefix without an already protected head. A legal writer result could therefore fail on reopen with `system/message requires a protected first surface head`.

The mismatch belongs to native relationship admission, not physical JSONL recovery or a particular provider. A provider connection can expose it by continuing an imported Session, but changing providers does not establish the cause. The [surface-node decision](../architecture/2026-09-02-system-prompt-as-surface-node.md) owns system-prompt representation and actual-head protection; the [native validation decision](../architecture/2026-09-17-native-v4-read-validation.md) owns mandatory relationship validation.

## Decision

Native V4 admission follows the current surface head rather than requiring the first encountered system message to have been the initial node. A system append after imported conversation remains at its recorded position and does not become a protected head. If a valid replacement makes a system message the first current surface node, the reader tracks that node as protected. Subsequent replacements and compaction retain the core Session's restrictions on that head; later system nodes remain unprotected.

This corrects the reader's interpretation of histories already accepted by the current core writer. It changes no declared persistence type, event representation, sequence coordinate, seeded-prefix cut, or Session version. The released V3 codec retains its own strict semantics. Older native V4 builds can still refuse this legal history; their refusal is safe incompatibility, not an invitation to rewrite the stored Session.

## Alternatives considered

**Insert an empty system head or reorder imported messages.** Rejected: this would change durable event positions and the model-visible order to satisfy a reader condition that the writer never required. Imported history remains unchanged.

**Truncate, manually edit, or re-save the log through an older writer.** Rejected: data repair is not justified when the stored history is legal. Such edits can discard conversation or change relationships independently of the actual defect.

**Disable relationship validation or change released V3 acceptance.** Rejected: the native V4 mismatch does not invalidate the remaining lifecycle, message, replacement, or compaction checks, and it does not justify changing a released historical codec.

## Consequences

Affected Sessions reopen unchanged with the fixed native reader. A system node at the current head remains protected, including one promoted there by replacement; a later node is not protected merely because it was the first system message encountered. Regression coverage must keep those positive and negative paths together with seeded-prefix preservation and append-on-first-prompt behavior. Required persistence and reopen verification uses synthetic imported conversation through a shipped profile rather than private Session contents.

The [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.2/seeded-session-system-head/guide.md) directs users to activate a fixed build rather than modify their logs. Source changes do not activate an installed application. Activation remains a separate deployment step and must not interrupt active work without authorization.
