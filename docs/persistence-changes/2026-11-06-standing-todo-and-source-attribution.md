---
description: Records a persistence type transition and its compatibility acknowledgement.
kind: persistence-change
---

# 2026-11-06-standing-todo-and-source-attribution

## Summary

Adds required standing todo-tree records and the plan-write event, plus resume-note and agent-queue message attribution, while retaining the released flat todo payload and per-turn lifetime.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-standing-todo-and-source-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "eee07178d507b4aa4c0b0341c72c210be93293e9008c238da7e151924cf8733f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "efa04be68ab4779cff59cb6b5bf9c3f0a5d5d0af8823516baddbad2706a37044"
    decision: same-version
  - root: "event:plan/write"
    previous: null
    after: "af1bdcd82bc701bb79eb1766d9d1c4a82a266322a62e20049116e6c392514d06"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "3d6f49af675263c19c89632a63e6439c4d39b61874660c87670bb13c799c3ca7"
    decision: same-version
  - root: "event:todo/tree-write"
    previous: null
    after: "767c863391b793b03ad4051d8b12f8225d71899464c49bc75cdeae562f4f0193"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "58112fc95a4541cdf6186a7ef3477d6cd789455b246d8bba1f8050cac91e033e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The Session writer remains V4. The declared todo/write payload is unchanged from acknowledged history: flat content plus pending, in_progress, or completed status. Current readers clear this legacy state at the next turn/start and do not inject it as a standing prompt. Current todo tools instead emit required todo/tree-write records for every standing plan, including flat input. The new event carries cancellation, priority, and children; older V4 readers reject its unknown required discriminator before Session adoption rather than dropping children or failing later in UI projection. Strict and recoverable codec tests preserve the complete row before this unsupported-feature refusal; the input is not transformed or truncated. New readers accept both event discriminators, preserve the latest mode in their projection, and retain standing trees across turns. The new plan/write event is likewise required and unknown older readers refuse it before adoption; historical logs without it retain no standing implementation plan. resume-note and agent-queue are additive attribution kinds only: released V4 admission accepts nonempty producer kinds and retains their JSON metadata in user, developer, inbox, and title-request message slots. These kinds impose no replay authority or validation requirement; resume-note only suppresses duplicate notices and the queue notice neither acknowledges messages nor mutates queue cursors. Historical attribution and message content remain unchanged. Tool-addition fields did not change. Existing committed Session JSONL generations are byte-unchanged; reviewed writer-retired oracles compare new tool writes and intentional standing prompt changes without rewriting historical replay input.

<a id="verification"></a>
## Verification

Executed focused todo, projection, consumer history, query, and gate tests: 7 files, 65 tests passed. Native V4 codec, exact attribution, source-slot, projection, snapshot manifest, and corpus policy tests: 6 files, 123 tests passed; expanded policy/manifest run: 76 tests passed. Keyless shipped headless replays passed for model-switch-notice, repeat-tool-reminder, subagent-max-tokens-partial, and todo-write; TypeScript SDK tool-scheduler-recovery refresh and replay passed with one todo/tree-write and no todo/write. Complete recorded-session corpus checks passed, including exact retired-event writer-oracle validation. Python SDK scheduler recovery refresh and replay passed with canonical V3/V4 hashes unchanged (parent-reported execution). verify-type-equiv and verify-upgrade-guides passed. git diff --name-only over snapshot canonical Session JSONL paths returned no changes. No Session version bump, committed-generation rewrite, or compatibility exemption was used.

<a id="dev-note"></a>
## Dev Note

None.
