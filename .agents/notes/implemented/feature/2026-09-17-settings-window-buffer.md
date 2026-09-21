# Agent Note: Settings opens as a window-manager buffer, not a modal

Status: implemented

## Problem

The settings shell (`ui-settings-general`) rendered a centered modal: a full-viewport mask over the app, its own Escape/mask/focus handling, and its own open-state lifecycle. The modal blocked the conversation while open, could not sit beside the chat, and duplicated window chrome the frame already owns. A full-page restyle would have inherited the same take-over shape; the harness UI is an Emacs-style window manager whose windows are the native surface for exactly this kind of persistent, secondary tool page.

## Decision

**Settings is a buffer.** The `settings` buffer kind joins the WM's singleton registry (seeded like sidebar/chat/details; killing it re-homes its leaves to the follow-current chat session buffer — the `session` singleton that replaced the `conversation` kind when chat sessions became per-window buffers, see [per-window session buffers](../feature/2026-09-21-per-window-session-buffers.md)), rendered through a new frame-level slot `settings.view` declared by ui-layout beside `terminal.view`. `ctx.layout` grows `openSettings`/`closeSettings`/`toggleSettings` mirroring the details-panel face: open splits the rightmost leaf row-wise into the canonical settings leaf; the pane participates in splits, focus, cycling (`C-x b` lists it), and per-workspace tree persistence like any other window.

The shell split in two occupants, both owned by `ui-settings-general`:

- `sidebar.settings` keeps only the trigger seat and the onboarding coordinator; the trigger calls `openWindow` (→ `ctx.layout.openSettings()`) instead of flipping local modal state. Onboarding steps mount from the trigger root (always mounted) and their `openSection` writes the shared active-section source and opens the window.
- `settings.view` renders the window body — nav rail over `settings.section` entries, header/actions, the active section's page. The active section id lives in an apply-scope observable shared by the nav and the onboarding path. No mask, no `aria-modal`, no Escape listener: the WM pane's mode line is the window chrome, and the sections' `close` prop routes to `ctx.layout.closeSettings()`.

The `settings.close` seat is no longer rendered by the shipped shell (the WM pane owns the close gesture); the slot type stays declared in the ui-settings contract for shells that do render their own close control.

## Alternatives considered

- **Full-viewport page (Codex-style takeover)** — restyle the modal into a screen-filling page with a "back to app" affordance. Rejected: it still blocks the conversation and fights the harness's own window-manager idiom; a page pretending to be native is neither a page nor a window.
- **Route-based settings (`/settings`)** — rejected: the app is a single-surface workspace, not a routed site; a route would tear down and rebuild the session surface around a settings visit.
- **Keep the modal alongside the window** (modal as narrow-viewport fallback) — rejected for now: two shells mean two active-section owners and double the chrome-copy surface for a fallback nothing currently needs; the window pane is resizable enough to serve narrow viewports.

## Consequences

- Zero registrant changes: every `settings.section` / `settings.general.item` contributor (General, Models, Plugins, Agent presets, feature rows such as the c0ntext evictor toggle) renders identically in the window.
- Settings persists across reloads through the wm tree snapshot when left open, and participates in expand-to-fill (zoom) for a full-surface view.
- `ILayout` implementors (test fakes) must supply the three new methods; `ui-settings-general` declares `layout` in its cordis inject and type-imports ui-layout's client face for the `settings.view` SlotMap merge.
- Modal-specific behaviors are gone by design: mask-click and Escape no longer close settings (the pane close gesture does), and there is no narrow-viewport modal fallback.
