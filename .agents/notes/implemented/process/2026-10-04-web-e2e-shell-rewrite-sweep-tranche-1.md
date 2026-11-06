# Agent Note: Web e2e adaptation to the rewritten shell — tranche 1 (five scenario files)

Status: implemented

## Problem

The shell rewrite (brand row + Agents|Chat layout modes, AgentGrid, sash-based WM panes; landed across the layout-modes work) shipped without its `apps/web` e2e sweep. Because the client plugin `lib/` bundles had not been rebuilt since before the rewrite, the e2e lane kept passing against stale lib output; a full `test:web` pipeline rebuild exposed the divergence. Five scenario files — the visible head of that exposure — are adapted here.

## Decision

- `scaffold.ts`: new `directToolCalls` launch option. Scenarios whose recorded/generated scripts call gated tools directly (`bash` with no preceding `todo_write`) opt into `native` tool presentation and disable the shipped todo-plan gate for that scaffold. Both divergences are scenario-scoped; the shipped composition stays default for everyone else (blanket native broke every fixture recorded against the paged default — `native` never registers `tool_search`).
- `chat-continuous-conversation`, `chat-long-interactions`: terminal rows now start expanded (eefdb9e795); the disclosure assertions toggle collapsed-first, keeping both states exercised.
- `cordis-tool-round`: aria region selector `[class*="centerCol"]` → `[data-pane="content"]` (centerCol no longer exists in any source or lib).
- `composer-tab-geometry`: Chat/Trajectory tab locators scoped to the banner (the brand-row Layout-mode switcher also exposes role=tab "Chat"); `setMeasuredViewport` no longer waits on `data-sidebar-collapsed` — that auto-collapse belonged to the old shell's global sidebar, absent from this surface; the conversation-column stable-frame settle is the synchronization.
- `details-session-lifecycle`: rewritten to the current shell. AppFrame root measured via the new `data-app-frame` hook; sidebar/context widths via `data-pane` kind hooks instead of dead inline grid tracks; the drag section drags the first root sash and asserts the clamped share cap; panel geometry resets across reloads by design (layout-store spec: "does not persist panel geometry"). Handles golden replaced by the sash contract.
- Goldens refreshed under `DSH_SNAPSHOT=refresh` (intentional output changes).

## Product changes

- `WmFrame.tsx`: `data-app-frame` on the frame root and `data-pane` kind on split pane wrappers (stable measurement hooks; repo data-* pattern).
- `WmFrame.tsx`: dragged sidebar widths now clamp to the 20% share ceiling (`SIDEBAR_SHARE_MAX`), not the untouched 18% default — the code capped at the default, so a drag could never grow the sidebar past its starting width, contradicting the block's own comment ("never exceeds a fifth").
- `WmFrame.tsx` + `SidebarRoot.tsx`: narrow-viewport auto-collapse wired for the chat-mode WM tree (`actions.setNarrow` from the resize-observed frame width below `SIDEBAR_AUTO_COLLAPSE`; `narrow && !narrowExpanded` collapses the sidebar owner to the rail, `data-sidebar-collapsed` hook on the rail). The store machinery and its documentation existed; the frame never fed it.

## Consequences

The wider lane still has ~dozens of scenario files red against fresh libs (stale selectors like `centerCol`, old chrome assumptions). That sweep belongs with the shell-rewrite owner; the `directToolCalls` pattern and the `data-app-frame`/`data-pane` hooks are the templates.

## Alternatives considered

**Switch every replay to native tool presentation.** Rejected: fixtures recorded against paged presentation call `tool_search`, which native presentation does not register. Only scenarios that directly call gated tools opt into the deviation.

**Keep testing stale bundles.** Rejected: passing against pre-rewrite artifacts does not validate the shipped source. Browser evidence requires rebuilt artifacts and selectors owned by the current frame.
