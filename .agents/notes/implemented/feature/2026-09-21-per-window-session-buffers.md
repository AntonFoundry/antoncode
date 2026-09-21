# Agent Note: Chat sessions are per-window session buffers, not one global surface

Status: implemented

## Problem

The window manager kept exactly one `conversation` buffer (`SINGLETON_BUFFER_IDS`), so every split showed the same globally-selected session: `C-x 2`/`C-x 3` cloned the one buffer, a sidebar click re-rendered every pane, and the workspace could never display two sessions side by side. Composing into a session was also ambiguous under splits: every composer registered document-level drag listeners and a full-viewport drop mask, so with N panes an image drop lit up the whole screen and attached to every pane's session.

## Decision

**Each chat window is a session buffer.** `wm.ts` adds the `session` buffer kind with `sessionId?: string`; `undefined` means the follow-current singleton (renders the sessions service's `current`, preserving the default layout's behavior), a defined id addresses `buffer:session:<sessionId>`. `sessionBuffer(sessionId?)` mints entries; `migrateLegacyConversation` (run by the store's `reconcile`, hence idempotent under repeated loads) rewrites persisted `kind: 'conversation'` snapshots into follow-current session buffers at the legacy roster position; killing a pinned session buffer re-homes its leaves to follow-current. Splits clone the anchor's session buffer into a NEW registry entry — the same session in two windows is two views, Emacs `C-x 2` semantics.

**Per-pane rendering is a slot-scope pin.** `RenderOpts.scopeSessionId` (ui-slots) makes the web-react slot renderer resolve the inject bundle from the new `sessions.provideInfoFor(id)` (stable per-session bundle identity; `maybeInfo` fallback) and wrap the output in `SessionPinProvider`, which overrides the ambient `BindingContext` for nested dispatch. WmFrame passes `scopeSessionId` only for pinned panes; follow-current panes render exactly as before. The conversation owner props grow `layoutSpan` ('single' | 'multi', chat-visible leaf count), `scopeSessionId`, and a leaf-bound `rebindPane(sessionId)` so a composer minting a session inside a pinned pane re-pins that pane instead of moving the global selection.

**Sidebar clicks are switch-to-buffer in the focused chat window.** A `current` transition re-binds only the focused leaf — and only when it currently shows a chat buffer — to a pinned buffer for the new session; unpinned panes keep following the global provider, and non-chat windows are never yanked.

**`C-x b` lists every workspace session.** Buffer candidates include one entry per session (`buffer:session:<id>`, display title from the sessions list, `open` hint when a visible leaf shows it); executing one ensures the registry entry and swaps it into the focused leaf. Pinned panes title their mode line/tab `Chat · <display title>`.

**Image drops are pane-scoped.** InputBar's document-level drag listeners are gone; dragenter/over/leave/drop are React handlers on the composer root with per-instance depth counting, and the drop resolves via `currentTarget` — exactly one pane's session receives the attachment. One module-level `ensureDocumentDropGuard()` document listener remains, `preventDefault`-ing only `Files` drags that miss every pane so the browser never navigates to a dropped file. `DropOverlay` gains a `variant` prop: the full-page mask survives only for `layoutSpan === 'single'`; multi-pane layouts get the pane-local `.paneMask` outline that blocks nothing else.

## Alternatives considered

- **N-followers: keep one buffer, add a per-leaf session override map** — rejected: it forks the buffer model into two parallel sources of truth (buffer id vs leaf-local override), and the registry/minibuffer/cycle machinery would special-case it everywhere; a session buffer IS the buffer, so every existing buffer operation composes for free.
- **Re-parent the React context per pane with a new provider type instead of pinning the slot scope** — rejected: business components must stay context-free (client `ctx` discipline); the pin belongs in the renderer, where scope resolution already lives, keeping ui-conversation unaware of panes.
- **Global drag state with a single app-level overlay + hit-testing** — rejected: hit-testing duplicates what `currentTarget` already resolves, and a centralized coordinator reintroduces the cross-pane coupling that caused the bug; only the miss-guard stays global.

## Consequences

- A workspace can show, compose into, and receive drops for as many sessions as it has panes; the previously global `current` survives only as the follow-current default and the sidebar/agent-board's green marker (AgentGrid untouched).
- `ISessions` implementors (test-support `TestSessions`) and the slot renderer host face must supply `provideInfoFor`; `ConvOwnerProps` consumers must accept the three new owner props.
- Sessions shown only in pinned panes are staged without becoming `current`: the frame syncs every visible pinned session id to the sessions service (`ISessions.setStaged`, mirrored on `SessionListState.staged`), which opens each id's history window (idempotent, selection untouched) — pinned panes render full backfilled history, and a blank session pinned in any visible pane stays sidebar-visible like the current blank one. Background sessions keep streaming as before.
- Snapshot-affecting chrome is unchanged for the default layout (titles gain the `Chat · <title>` form only under pinning); the DOM `data-buffer` attribute of chat panes is now `"session"`.

## Testing

`wm.client.spec.tsx` covers the session-buffer model (ids, default-tree seeding, migration idempotency, kill re-homing, pinned split cloning), the C-x b session roster, focused-leaf-only sidebar rebind, `layoutSpan`, and pane-bound `rebindPane`; `web-react/tests/scoped-slots-pinning.client.spec.tsx` pins the scoped dispatch; `input-bar.client.spec.tsx` retargets drag tests to the pane and adds a two-instance isolation test (a drop on pane A never touches pane B).
