---
kind: upgrade-guide
description: "Session readers must recognize required automatic model failover events before opening logs written by enabled failover policies."
---

# Automatic model failover Session readers

## Change

Enabling the optional `llm-retry.failover` policy can write `llm/failover`, `llm/failover-attempt` and `llm/failover-exhausted` Session events. These log-only events retain effective routes, cooldowns and bounded recovery history. Model-visible switch and exhaustion notices use ordinary `user/message` records with `source.kind: model-failover`.

The Session format version is unchanged. Older readers that do not recognize these required events refuse affected Sessions instead of ignoring recovery state. Feature-free historical Sessions remain readable. Disabling failover does not remove records already written or make those Sessions readable by an older harness.

## Migration

1. Upgrade the harness and any custom Session readers before enabling `failover.enabled` in the `@deepseek-ai/dsh-llm-retry` plugin's `cordis.yml` configuration. Leave the policy omitted or disabled to retain existing routing behavior; the [package reference](../../../../packages/llm/llm-retry/README.md) owns its exact route and limit fields.
2. Update custom event readers to preserve the three required event types and `model-failover` notice attribution. Readers that cannot interpret the recovery events must refuse before execution, mutation or tail repair; they must not discard the records as corrupt data. The [persistence acknowledgement](../../../persistence-changes/2026-10-26-automatic-model-failover.md) records the reader compatibility decision.
3. Keep existing Session generations unchanged. No conversion, global version bump or log rewrite is required. Do not delete recovery events to make a Session open in an older reader.
4. Confirm that feature-free logs still open, and that a failover-enabled log reopens with the recorded effective route and notices intact. An older reader must report unsupported required events without changing the file.
