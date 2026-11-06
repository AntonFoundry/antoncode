# Retained Anton capability inventory

## Scope and evidence

This working inventory covers the 24 retained source files under `packages/client/runtime/src` and `packages/host/apiproxy/src`. All files remain in their original locations. Neither an archive nor a source deletion is part of this proposal. Findings describe the inspected checkout and shipped composition declarations, not an end-to-end runtime verification. The running installed application can differ from this checkout.

A retained interface, a mounted business service, a selected Remote contribution, and a working UI caller are different levels of completeness. Missing old RPC envelopes are not by themselves missing functionality.

## Feature matrix

| Capability | Retained behavior | Current implementation and gap | Recommended owner |
|---|---|---|---|
| Claude login | Start browser approval, submit pasted approval code, cancel login | Equivalent operations in `packages/api/oauth-controller/src/index.ts` and `ui-settings-models` operations. New typed Remote returns token-free views; old envelopes need not be resurrected. | Existing OAuth controller and Claude provider; no new plugin. |
| OpenCode login | Start device login, poll status, choose organization/workspace, cancel | Equivalent operations in the OAuth controller and Models UI. Current errors and response envelopes differ deliberately. | Existing OAuth controller and OpenCode provider. |
| Interactive terminals | Spawn PTY, poll output, write input, resize, dispose | `guiTerminal` provides all five operations and the terminal UI calls them. Window-manager close still attempts the retired `connection.api.term.dispose` path, so closing a terminal buffer can skip backend disposal. | Repair the layout close callback to use the existing terminal Remote, with owned lifetime tests. |
| Worktrees | List/create/status, read/set mode preference, remove | Modern Worktree Remote and registry implement all six operations; preferences arrive with the list. Create/status/preferences have current client consumers. A production UI removal caller was not found. | Extend existing Workspace client and worktree controls for confirmed removal, including dirty/force confirmation. |
| LangFlow lifecycle | Status, start, stop, open embedded editor | Modern sidecar Remote and Workflows tab are mounted and call these operations. The old optional process-id display is not in the new status view. | Existing sidecar and UI; no duplicate lifecycle plugin. |
| Durable flow definitions and block library | List/get/save/delete workflows, run workflow, list/get runs, search/save/delete library blocks | `FlowBuilderService` implements all ten operations. A browser Flow Remote is absent from the selected Remote roster. The Workflows tab embeds LangFlow and is not a UI for this separate durable flow domain. Agent flow tools expose only a subset; default Web accessibility needs explicit composition verification. | Add a thin Flow Remote beside the existing flow service and extend existing flow UI with distinct durable-flow/library/run views. Keep LangFlow data separate unless an explicit adapter is designed. |
| Agent orchestration board | Aggregate workspace/session board; cancel a session | Current `ui-orchestrator` derives shared workspace/session snapshots and calls `remote.session.cancel`; old aggregate endpoints are unnecessary. Its package is not mounted by the inspected shipped bundle. Other visible actions such as approve/retry/inject note have no implementation, but were not supported by the retained kill-only API either. | Compose the existing orchestrator plugin and fix reactive inputs; do not recreate the API aggregate. |
| Board activity/transcript tails | Four-line summary or 48-line CLI-style tail; tool arguments/results; user/assistant/error lines | Retained pure derivation exists, but layout `fetchSessionTail` returns `undefined`. Current event formats and compact Assistant runs differ from assumptions in the old helper. | A bounded session-derived view in the Session/Conversation data owner, consumed through framework hooks by layout panes. |
| Board model and actions | Show selected model, interrupt or prompt a session | Layout still has `fetchSessionModel` returning `undefined` and prompt/interrupt stubs. Existing Session controller operations should be reused rather than reviving old API code. | Existing Session client/controller plus layout injection callbacks and access checks. |
| Inline images and video | Media MIME typing; full-file and single-range HTTP responses; 206/416 seeking; optional ffmpeg video-copy/AAC fallback | Viewer components still construct `/api/host/media` URLs. The inspected current code has no mounted equivalent handler outside the retained file; that file imports an absent downloads module. Modern workspace-files supports authorized byte/range reads, but is not automatically a streaming/remux endpoint. | Workspace-authorized media provider integrated with existing resource/Fetch mechanisms; optional separately configurable remux provider using managed subprocess ownership. |
| Agent Mail operations | Address/peer discovery, local/direct inboxes, send, acknowledge | Modern Agent Mail Remote and queues implement these functions under owner-only access policy. The old grant-bearing wire API is not required for the trusted owner UI. | Existing queue service and Agent Mail UI. |
| Scoped native consent | Operation-scoped grants bound to exact live Agent, workspace and origin; challenge/redeem/revoke; expiry and attempt bounds | Retained optional consent ceremony is not present in owner-only Remote UI. This is a potential additional security capability, not proof the current owner UI is unauthorized. Never grant access to shared viewers merely to restore old behavior. | Optional authorization provider only if separately required, consuming current principal/access services. |
| Private bridge proof and display | Signed short-lived forwarding assertions, nonce replay protection; native challenge display and private stdin seed delivery | Retained code is tied to the old carrier and local bridge assumptions. Current owner authentication is a different model. Exact bridge/native parity needs security review before reuse. | Current bridge/authorization owners, not public business Remote methods. |

## Complete retained-file map

| Files | Capability |
|---|---|
| `packages/client/runtime/src/client/sessions/tail.ts` | Board summary and transcript derivation. |
| `packages/host/apiproxy/src/api/claude-oauth.ts`, `claude-oauth.schema.ts` | Claude login operations and legacy wire validation. |
| `packages/host/apiproxy/src/api/opencode-oauth.ts`, `opencode-oauth.schema.ts` | OpenCode login operations and wire validation. |
| `packages/host/apiproxy/src/api/term.ts`, `term.schema.ts` | PTY operations and dimensions/input validation. |
| `packages/host/apiproxy/src/api/worktree.ts`, `worktree.schema.ts` | Worktree operations, preference variants, and validation. |
| `packages/host/apiproxy/src/api/langflow.ts`, `langflow.schema.ts` | Sidecar lifecycle and status validation. |
| `packages/host/apiproxy/src/api/flow.ts`, `flow.schema.ts` | Durable flow/block/run operations and validation. |
| `packages/host/apiproxy/src/api/orchestrator.ts`, `orchestrator.schema.ts` | Board aggregation and kill-only action validation. |
| `packages/host/apiproxy/src/api/agent-mail.ts`, `agent-mail.schema.ts` | Grant-bearing mail operations and validation. |
| `packages/host/apiproxy/src/api/media-response.ts` | HTTP ranges, media streaming, and ffmpeg fallback. |
| `packages/host/apiproxy/src/agent-mail-consent.ts` | Scoped challenge/grant lifetime and revocation. |
| `packages/host/apiproxy/src/agent-mail-display.ts` | Native challenge-display delivery. |
| `packages/host/apiproxy/src/agent-mail-forward.ts` | Signed bridge-origin proof and replay protection. |
| `packages/host/apiproxy/src/native-consent-binding.ts` | Exact action-to-challenge binding. |
| `packages/host/apiproxy/src/native-consent-code.ts` | Challenge-code generation and bounded verification. |
| `packages/host/apiproxy/src/native-consent-stdin.ts` | Private native-display child input. |

## Proposed migration sequence

1. **Repair existing wiring:** terminal disposal, board prompt/cancel/model reads, and deliberate orchestrator composition. Verify close-versus-split ownership so closing one view never kills a PTY retained by another view. Do not enable unsupported actions as no-ops.
2. **Restore bounded board tails:** translate current durable and compact/live event forms in their owning data layer. Preserve session access checks, bounded work, cancellation, and independent pane identities. Do not poll/rescan every session's entire history.
3. **Restore authorized media:** resolve files through the current filesystem authority, preserving explicitly allowed outside-workspace reads rather than assuming that every read is workspace-confined. Require bounded ranges, rejection of unauthorized traversal or symlink escape, correct 206/416/HEAD semantics, and disconnect cleanup. Add optional remux only with explicit configuration, admission limits, subprocess error reporting, and awaited teardown. Native video re-encoding is not required by the retained code.
4. **Expose durable workflows:** typed current Remote with validated requests and current principal/access policy; separate durable workflow, library, and run-history UI from the LangFlow embed. Verify storage compatibility and emitted events; do not imply automatic interchange between the two workflow engines.
5. **Decide optional consent policy:** use the retained code as reference for guarantees, not as an approved authentication design. Add a provider only if scoped native ceremony is still desired. Test origin spoofing, replay, expiry, attempt bounds, exact Agent/workspace/operation binding, revocation, and disposal.

## Source anchors for review

- `packages/client/ui-layout/src/client/index.ts`: `interruptSession`, `fetchSessionTail`, `fetchSessionModel`, `promptSession`, `mediaUrl`, and `disposeTerminalSession` show the remaining carrier/wiring gaps.
- `packages/api/remotes/src/client/index.ts`: selected Remote contributions include OAuth, LangFlow, Agent Mail, terminals, Session and Workspace, but no durable Flow contribution.
- `packages/api/oauth-controller/src/index.ts`, `packages/api/terminal-controller/src/gui-terminal.ts`, and `packages/api/workspace-controller/src/worktree-controller.ts`: modern business operations already exist.
- `packages/flowbuilder/flowbuilder-service/src/service.ts`: durable flow/block/run operations; `packages/client/ui-flowbuilder/src/client/index.ts`: current LangFlow-only UI integration.
- `packages/client/ui-orchestrator/src/client/index.ts`: local shared-snapshot derivation and Session cancel; `packages/bundle/web-app/cordis.patch.yml`: shipped UI composition.
- `packages/api/workspace-files/src/index.ts`: authorized file reads, stat and byte-range reads; retained `media-response.ts` is not itself mounted by these APIs.
- `packages/experimental/liveshare/src/endpoint-classification.ts`: Agent Mail Remote methods are owner-only; `packages/interaction/agent-queue/src/mail-remote.ts`: current mail methods.

## Verification boundary

This inventory used source and live read-only capability inspection only. It did not launch terminals, native dialogs, browsers, video converters, authentication flows, printer jobs, builds or tests. Implementation should be split into scoped feature changes with real-composition tests; source files remain available until replacement behavior is demonstrated and a separate removal decision is made.
