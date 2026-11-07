---
description: Records a persistence type transition and its compatibility acknowledgement.
kind: persistence-change
---

# 2026-10-26-automatic-model-failover

## Summary

Adds required automatic model failover switch, attempt and exhaustion events, plus attribution-only model-failover message sources. The writer keeps the current Session format version with an explicit same-version reader compatibility decision.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-26-automatic-model-failover
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-06-standing-todo-and-source-attribution"
    after: "7366f52313f4a5e1e5bb4d9c1eb8e53cc7fe84d0806f38ef0349dc5f258052f7"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-06-standing-todo-and-source-attribution"
    after: "e0a76b7d05974114f2b164ba597c513da1b4f5959089a0af1e1ea9adffc217fc"
    decision: same-version
  - root: "event:llm/failover"
    previous: null
    after: "d1039be27c583af81e7f1169c766665706c44e585c10e99e8c6b7f1bcf622e16"
    decision: same-version
  - root: "event:llm/failover-attempt"
    previous: null
    after: "7c26362d12a9fb9b62a069852a112257d7b719a811f67a8eade3ebcbe06f73f8"
    decision: same-version
  - root: "event:llm/failover-exhausted"
    previous: null
    after: "98e69abe7abd146b1d4c9776ad4f046b7d5890dab6a4479ef9f7b9e2e9d2a791"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-06-standing-todo-and-source-attribution"
    after: "b323aba2f71d93175f090a6a371647c40ca557260c02e3feaa87f8c1c277eb4f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-06-standing-todo-and-source-attribution"
    after: "5b74b8e1f8dc813fbcfc9f34afba1a0f06b4b3a26b214a93892b4ad6e986bd43"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Historical records retain their original payloads and meaning; logs without failover records keep existing routing behavior. New readers recover effective routes, cooldowns and bounded attempt facts from the three new events without replaying provider calls or emitting notices. The model-failover source is qualified attribution-only metadata: readers preserve its JSON and derive the persisted user or developer message without requiring the producer. Older readers do not recognize the new required llm/failover, llm/failover-attempt and llm/failover-exhausted event types and refuse them before Session adoption, execution, append or recovery truncation. They are deliberately not ignorable. The existing unknown-required-event admission mechanism reports unsupported data rather than corruption, and provider read/write refusal leaves the source file unchanged. Feature-bearing logs require an upgraded reader, not a version conversion or event deletion. Existing discriminators prevent unsafe interpretation, so no writer-version bump or historical generation rewrite is needed.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/open-vocabulary.spec.ts packages/session/session-persistence-jsonl/tests/current-event-admission.spec.ts packages/session/session-persistence-jsonl/tests/migration-refusal.spec.ts: 3 files and 145 tests passed. These checks exercise unknown-required-event refusal, opaque ignorable-event preservation, and provider read/write refusal without truncating or replacing the source file. The generation preview identified only the three new event roots and model-failover attribution additions in agent/inbox/spliced, developer/message, session/title-llm-request and user/message. pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts packages/core/session/tests/message-projections.spec.ts: 17 tests passed, covering direct attribution preservation and message projections. pnpm exec vitest run packages/llm/llm-retry/tests/failover-persistence.spec.ts: 1 test passed, retaining all new log-only records through JSONL without deriving diagnostic messages. DSH_EXAMPLE_MODE=src pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts snapshots/sdk/sdk.snapshot.ts -t model-failover-quota: both headless and TypeScript SDK failover replays passed, including the persisted notice and fallback reply. The recorded-session corpus policy passed all 3 checks; persistence catalog, history and historical format verification also passed. uv run --project python/sdk --group test pytest python/sdk/tests/test_model_failover_snapshot.py -q: 1 passed without skipping, projecting the exact quota attempt, switch notice, fallback assistant source and completed result through the public Python SDK.

<a id="dev-note"></a>
## Dev Note

None.
