# Agent Note: The plan block is a toolview row, and chat file clicks open inline first

Status: implemented

## Problem

`plan_write`/`exit_plan_mode` returned presentation `locations: [{ path }]`, but the chat had no dedicated presentation for them: both fell through to the generic tool card, and the chat view's `openFile` face routed every file click to `workspaces.openPath` → `host.openPath` → the OS default application. The Antigravity-style interaction — click the plan block, the chat splits, the plan markdown opens in a buffer on the right — existed nowhere: the inline split-open (`openInline`: focused-leaf anchor → `buffer:file:<path>` → row split → focus) was reachable only from ui-layout's own frame face (ido/dired), and no cross-plugin face exposed it.

## Decision

**`ILayout.openFile(path): boolean` is the one cross-plugin inline opener.** `LayoutController` gains the routing the frame's inject closure used to own privately: with the wm store attached and `opensInline(path)` true (text, markdown, image, video families per `file-view.ts`), it splits the focused leaf row-wise into a `buffer:file:<path>` buffer, focuses it, and returns `true`; a missing wm store, an OS-open binary family, or a leaf-less tree returns `false` and the caller owns the Host-open fallback. `WmTreeSource` widens to carry `buffers`/`focusedLeafId` and the `setBuffers`/`setFocus` actions so the controller can perform the split; the frame's `openPath` face delegates to the controller, keeping one home for the routing decision.

**The chat view's `openFile` face routes inline-first.** ui-conversation's chat inject face resolves the path against the session cwd and calls `ctx.layout.openFile`; only unhandled families fall through to `workspaces.openPath` (OS). Every file-path click in chat — the plan block, mutation rows, read rows, deliverable chips — now splits the chat instead of leaving the app, matching the opener contract ui-layout already documented for its own faces.

**The plan block is a keyed toolview row.** `ui-tool` registers `plan_write` and `exit_plan_mode` into `tool.call.toolview` with `PlanRow`, composing the shared `ToolRow`: pen-and-list icon, the plan's `args.title` (locale fallback `plan.rowTitle`), and a summary that names the plan markdown's first non-empty line plus the saved path — the summary text doubles as `ToolRow`'s file link, so the file name stays visible in the chat and its click carries the saved path through the owner `openFile` face into the inline split, where `ui-file-markdown` renders it beside the chat. Malformed model JSON falls back to the generic row summary with the default `implementation_plan.md` path.

## Alternatives considered

- **A dedicated plan-details panel instead of the buffer split** — rejected: the plan is a file on disk and `ui-file-markdown` already renders it with the shared markdown engine; a second plan viewer would fork presentation and lose the always-current-disk behavior.
- **Routing only the plan row through the inline opener (leaving other file clicks on the OS path)** — rejected: `openPath` routing is one decision (ui-layout's documented opener contract); forking it per-caller would make mutation-row and deliverable links behave differently from plan links in the same chat.
- **Registering the plan row from a new ui-plan client package** — rejected: presentation detail of the existing tool-row surface; the `tool.call.toolview` registrant pattern (todo/ask/file-mutation rows) is the established seam, and the locale keys already live in ui-conversation's conversation table.

## Consequences

- Chat file clicks no longer leave the app for text/markdown/image/video families; `host.openPath` now serves only binaries. Callers that relied on the OS-open behavior for inline families (none known) would see the split instead.
- `ILayout` implementors (test fakes) must add `openFile`; `WmTreeSource` fakes must supply `buffers`, `focusedLeafId`, `setBuffers`, and `setFocus` (the engine store satisfies it structurally).
- The plan row derives everything from frozen call args — a running call already shows title, summary, and the intended path; result `locations` are not re-parsed (the saved path always comes from `args.path` or the tool default, as plan-mode resolves it).
- [2026-09-18 subagent implementation plans](../../implemented/feature/2026-09-18-subagent-implementation-plans.md) described this split-open behavior for plan locations; this note is the mechanism that makes it real.

## Testing

`ui-layout/tests/service.client.spec.ts` covers the controller face (handled split with buffer/tree/focus writes, first-leaf anchor, binary unhandled, unattached unhandled, leaf-less unhandled); `ui-conversation/tests/apply-inject.client.spec.tsx` covers inline-first routing (layout tried with the resolved path, handled → no Host call, unhandled → Host fallback); `ui-tool/tests/plan-row.client.spec.tsx` covers both registrations with disposal, title/summary/link rendering for settled and running calls, the `openFile` click payload, locale-fallback and malformed-args fallbacks, and the `exit_plan_mode` path.
